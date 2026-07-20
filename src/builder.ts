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

// johnbuilder's own credential store never keeps a working refresh token, so
// Claude Code needs its long-lived OAuth token set explicitly. It's kept in
// ~/.claude_oauth_token *inside johnbuilder's own home* (chmod 600, owned by
// johnbuilder) rather than passed through revaldyas's process env/argv:
// sudo logs the full command line of anything it runs, and an uncaught spawn
// error dumps the whole argv array — both would otherwise leak the token in
// plaintext (this happened once; see DEPLOYMENT.md). Reading the file
// happens inside spawnClaudeAsBuilder, after sudo's setuid to johnbuilder.

// Run a command AS johnbuilder — privilege drop via sudo (the bot's user has
// NOPASSWD sudo; johnbuilder itself has none). No shell: argv is passed
// literally, so user text in the prompt can't inject commands.
function asBuilder(args, opts = {}) {
  return execFileP("sudo", ["-u", BUILDER_USER, "-H", "--", ...args], opts);
}

function spawnAsBuilder(args, opts = {}) {
  const child = spawn("sudo", ["-u", BUILDER_USER, "-H", "--", ...args], opts);
  // Without this, a spawn-level failure (e.g. permission/ENOENT) is an
  // unhandled 'error' event that crashes the whole bot process — happened
  // once already (see DEPLOYMENT.md). Log and let the caller's own
  // close/timeout handling deal with the fallout instead.
  child.on("error", (err) => console.error("[builder] spawn failed:", err.message));
  return child;
}

// Run Claude Code as johnbuilder, cd'd into `dir`. Both the cd and the token
// file read must happen *after* sudo's setuid — johnbuilder's home (and the
// token file in it) isn't readable/traversable by revaldyas, so Node's own
// `cwd` spawn option (which chdir's before exec, as revaldyas) fails with
// EACCES (also happened once — see DEPLOYMENT.md). `dir` and `claudeArgs`
// are passed as separate argv elements (bash positional params via `--`),
// never interpolated into the script string, so untrusted text (the build
// description) can't inject shell commands.
function spawnClaudeAsBuilder(dir, claudeArgs, opts = {}) {
  const script = 'cd "$1" && shift && export CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.claude_oauth_token 2>/dev/null)" && exec "$@"';
  return spawnAsBuilder(["bash", "-c", script, "--", dir, CLAUDE_BIN, ...claudeArgs], opts);
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

// `--output-format stream-json` emits one JSON object per line as Claude Code
// works (tool calls, messages, the final result) instead of staying silent
// until the whole run ends. Pure read-side: doesn't touch the running build,
// just lets app_status/list_apps report what's actually happening right now.
function trackProgress(slug, line) {
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    return; // stray non-JSON output (e.g. a warning) — ignore, not fatal
  }
  const p = projects.get(slug);
  if (!p) return;

  let action = null;
  if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block.type === "tool_use") {
        const detail = block.input?.command || block.input?.file_path || block.input?.path || "";
        action = `🔧 ${block.name}${detail ? `: ${String(detail).slice(0, 80)}` : ""}`;
      } else if (block.type === "text" && block.text?.trim()) {
        action = block.text.trim().slice(0, 200);
      }
    }
  } else if (evt.type === "result") {
    action = evt.is_error ? `❌ ${String(evt.result || "error").slice(0, 200)}` : "✅ selesai, lagi diserve...";
  }
  if (action) {
    projects.set(slug, { ...p, progress: { action, updatedAt: Date.now(), turns: (p.progress?.turns ?? 0) + 1 } });
  }
}

// child.stdout 'data' events don't align with NDJSON line boundaries.
function makeLineSplitter(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) onLine(line);
    }
  };
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

  const claudeArgs = [
    "-p",
    buildPrompt(description, isIteration),
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    MAX_TURNS,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  const child = spawnClaudeAsBuilder(dir, claudeArgs, { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stdout.on("data", makeLineSplitter((line) => trackProgress(slug, line)));
  child.stderr.on("data", (d) => (stderr += d));

  const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);

  child.on("close", async (code) => {
    clearTimeout(timer);
    const p = projects.get(slug);
    if (code !== 0) {
      const msg = (stderr.trim() || p?.progress?.action || "unknown error").slice(-600);
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
    progress: p.status === "building" ? p.progress?.action : undefined,
  }));
}

export function getProject(slug) {
  const s = slugify(slug);
  const p = projects.get(s);
  if (!p) return null;
  return {
    slug: s,
    status: p.status,
    url: p.port ? `http://${PUBLIC_HOST}:${p.port}` : null,
    error: p.error,
    progress: p.status === "building" ? p.progress?.action : undefined,
    progress_updated_seconds_ago: p.status === "building" && p.progress ? Math.round((Date.now() - p.progress.updatedAt) / 1000) : undefined,
  };
}
