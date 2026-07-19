import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { getSocket } from "./whatsapp/connection.js";
import { toWhatsAppFormat } from "./format.js";

const execFileP = promisify(execFile);

/**
 * Web-app builder: John delegates real coding work to Claude Code running as
 * the unprivileged `johnbuilder` user (no sudo, can't read the bot's secrets
 * — see the VPS setup). Each project lives in its own dir and is served on
 * its own port; builds run async and DM the owner when done.
 *
 * Everything the agent touches is confined to johnbuilder's home, so an
 * autonomous (permission-bypassing) coding session can't wreck the server.
 */

const BUILDER_USER = "johnbuilder";
const CLAUDE_BIN = "/opt/claude-code/claude";
const PROJECTS_ROOT = "/home/johnbuilder/projects";
const PUBLIC_HOST = process.env.BUILDER_PUBLIC_HOST || "103.150.197.170";
const PORT_BASE = 5100;
const PORT_MAX = 5199;
const BUILD_TIMEOUT_MS = 20 * 60_000; // a real app build can take many minutes
const MAX_TURNS = "100";

// slug -> { status, port, description, serverPid, startedAt, finishedAt, error }
const projects = new Map();

function slugify(name) {
  return (
    String(name || "app")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "app"
  );
}

function allocatePort(slug) {
  const existing = projects.get(slug);
  if (existing?.port) return existing.port;
  const used = new Set([...projects.values()].map((p) => p.port).filter(Boolean));
  for (let p = PORT_BASE; p <= PORT_MAX; p++) if (!used.has(p)) return p;
  throw new Error("no free preview port");
}

// Run a command AS johnbuilder — privilege drop via sudo (the bot's user has
// NOPASSWD sudo; johnbuilder itself has none). No shell: argv is passed
// literally, so user text in the prompt can't inject commands.
function asBuilder(args, opts = {}) {
  return execFileP("sudo", ["-u", BUILDER_USER, "-H", "--", ...args], opts);
}

function spawnAsBuilder(args, opts = {}) {
  return spawn("sudo", ["-u", BUILDER_USER, "-H", "--", ...args], opts);
}

function buildPrompt(description, isIteration) {
  return (
    (isIteration
      ? "You are iterating on an existing web app in the current directory. Apply this change:\n\n"
      : "Build a complete, working web app in the current directory based on this request:\n\n") +
    `"${description}"\n\n` +
    "Requirements:\n" +
    "- The app MUST be runnable via a `start.sh` script in this directory that starts it listening on " +
    "0.0.0.0 and on the port given by the $PORT environment variable (default 3000 if unset). Create/keep " +
    "that start.sh.\n" +
    "- Install any dependencies into this directory (npm install here). Keep everything self-contained.\n" +
    "- Prefer a simple, reliable stack (Node/Express + static frontend, or a single static site) unless the " +
    "request truly needs more. Use a local SQLite file for storage if persistence is needed.\n" +
    "- Make it actually work end-to-end, with sensible dummy data where helpful.\n" +
    "- Do NOT try to use sudo, do NOT touch anything outside this directory.\n" +
    "When finished, verify `PORT=8099 bash start.sh` boots without errors, then stop it."
  );
}

async function ensureProjectDir(slug) {
  const dir = `${PROJECTS_ROOT}/${slug}`;
  await asBuilder(["mkdir", "-p", dir]);
  return dir;
}

// Stop any running server for this slug, then start start.sh on its port.
async function serveProject(slug, dir, port) {
  const prev = projects.get(slug);
  if (prev?.serverPid) {
    try {
      await asBuilder(["kill", String(prev.serverPid)]);
    } catch {}
  }
  // Detached background process; nohup so it outlives this call. Log to the
  // project dir for debugging.
  const child = spawnAsBuilder(
    ["bash", "-c", `cd ${dir} && PORT=${port} nohup bash start.sh > server.log 2>&1 & echo $!`],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  let pidOut = "";
  child.stdout.on("data", (d) => (pidOut += d));
  await new Promise((r) => child.on("close", r));
  const pid = parseInt(pidOut.trim(), 10);
  return Number.isInteger(pid) ? pid : null;
}

async function healthCheck(port, { attempts = 15, delayMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function notify(chatJid, text) {
  try {
    await getSocket()?.sendMessage(chatJid, { text: toWhatsAppFormat(text) });
  } catch (err) {
    console.error("[builder] notify failed:", err.message);
  }
}

/**
 * Kick off a build. Returns immediately; the owner is DM'd when it finishes.
 */
export async function startBuild({ projectName, description, chatJid, isIteration = false }) {
  const slug = slugify(projectName);
  if (projects.get(slug)?.status === "building") {
    return { error: `proyek "${slug}" lagi dibangun, tunggu itu selesai dulu` };
  }
  const port = allocatePort(slug);
  const dir = await ensureProjectDir(slug);
  projects.set(slug, {
    ...projects.get(slug),
    status: "building",
    port,
    description,
    startedAt: Date.now(),
    error: null,
  });

  const args = [
    CLAUDE_BIN,
    "-p",
    buildPrompt(description, isIteration),
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    MAX_TURNS,
    "--output-format",
    "json",
  ];
  const child = spawnAsBuilder(args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));

  const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);

  child.on("close", async (code) => {
    clearTimeout(timer);
    const p = projects.get(slug);
    if (code !== 0) {
      const msg = (stderr || stdout || "unknown error").slice(-600);
      projects.set(slug, { ...p, status: "failed", finishedAt: Date.now(), error: msg });
      await notify(chatJid, `⚠️ Build "*${slug}*" gagal.\n\`\`\`\n${msg}\n\`\`\`\nCoba minta lagi atau ubah deskripsinya.`);
      return;
    }
    // Started successfully — now boot the app and health-check it.
    const pid = await serveProject(slug, dir, port).catch(() => null);
    const up = pid ? await healthCheck(port) : false;
    const url = `http://${PUBLIC_HOST}:${port}`;
    projects.set(slug, { ...p, status: up ? "running" : "built", finishedAt: Date.now(), serverPid: pid });
    if (up) {
      await notify(chatJid, `✅ "*${slug}*" udah jadi dan jalan!\n${url}\n\nMau diubah/ditambah? Bilang aja.`);
    } else {
      await notify(
        chatJid,
        `✅ "*${slug}*" udah dibangun, tapi John belum berhasil ngejalaninnya otomatis. ` +
          `Cek log-nya atau minta John benerin cara start-nya.`
      );
    }
  });

  return { slug, port, status: "building" };
}

export function listProjects() {
  return [...projects.entries()].map(([slug, p]) => ({
    slug,
    status: p.status,
    url: p.port ? `http://${PUBLIC_HOST}:${p.port}` : null,
    description: p.description,
  }));
}

export function getProject(slug) {
  const s = slugify(slug);
  const p = projects.get(s);
  if (!p) return null;
  return { slug: s, status: p.status, url: p.port ? `http://${PUBLIC_HOST}:${p.port}` : null, error: p.error };
}
