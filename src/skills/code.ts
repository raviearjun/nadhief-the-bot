import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { isConfirmation, isCancellation } from "./shell.js";

const run = promisify(execFile);

/**
 * DANGER SKILL — runs Claude Code (the `claude` CLI) headlessly on the VPS
 * with --dangerously-skip-permissions, i.e. full autonomous file/shell access
 * inside the given directory, no per-step approval (headless mode has no
 * terminal to approve from). Same trust model as shell.ts: owner-only,
 * DM-only, staged + explicit confirmation — the model never runs anything
 * directly, only isConfirmation() on the owner's own next message can trigger
 * it. Auth comes from CLAUDE_CODE_OAUTH_TOKEN in the bot's own environment.
 */

const EXEC_TIMEOUT_MS = 10 * 60_000; // coding tasks run longer than shell one-liners
const MAX_OUTPUT_CHARS = 3_500;
const PENDING_TTL_MS = 5 * 60_000;
const DEFAULT_BASE_DIR = process.env.HOME || "/home/revaldyas";

const pending = new Map(); // senderNumber -> { task, cwd, at }

export function setPendingCodeTask(senderNumber, task, cwd) {
  pending.set(senderNumber, { task, cwd, at: Date.now() });
}

export function getPendingCodeTask(senderNumber) {
  const p = pending.get(senderNumber);
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(senderNumber);
    return null;
  }
  return p;
}

export function clearPendingCodeTask(senderNumber) {
  pending.delete(senderNumber);
}

export { isConfirmation, isCancellation };

export async function executeCodeTask(task, cwd) {
  try {
    const { stdout, stderr } = await run(
      "claude",
      ["-p", task, "--output-format", "text", "--dangerously-skip-permissions"],
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
    );
    const out = [stdout, stderr].filter(Boolean).join("\n").trim() || "(tidak ada output)";
    return { ok: true, output: out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) + "\n[...dipotong]" : out };
  } catch (err) {
    const out = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    return {
      ok: false,
      code: err.code ?? "error",
      output: (out || err.message).slice(0, MAX_OUTPUT_CHARS),
      timedOut: err.killed === true,
    };
  }
}

function resolveCwd(input) {
  const dir = path.resolve(DEFAULT_BASE_DIR, input || ".");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  return dir;
}

// Owner-only AND DM-only — see file header.
export function skills(ctx) {
  if (!ctx.isOwner || ctx.isGroup) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "run_claude_code",
          description:
            "Stage a Claude Code (coding agent) task to run headlessly on this VPS. Use when the owner asks you " +
            "to write/fix/explore/debug code or run a coding agent on a project. Claude Code gets FULL autonomous " +
            "file and shell access inside the given directory once it runs — no per-step approval, since it's " +
            "headless. IMPORTANT: this does NOT run immediately, it only stages it. After calling this, show the " +
            "owner the exact task and directory and ask them to confirm; the system runs it only once they reply " +
            "'ya'/'gas'. Compose the full, precise task description yourself.",
          parameters: {
            type: "object",
            properties: {
              task: { type: "string", description: "The exact instruction/prompt to give Claude Code" },
              cwd: {
                type: "string",
                description: `Directory to run in, relative to ${DEFAULT_BASE_DIR} (or absolute path). Defaults to ${DEFAULT_BASE_DIR} itself.`,
              },
            },
            required: ["task"],
          },
        },
      },
      execute: ({ task, cwd }) => {
        const t = String(task ?? "").trim();
        if (!t) return { error: "task kosong" };
        const dir = resolveCwd(cwd);
        if (!dir) return { error: `direktori tidak ditemukan: ${cwd}` };
        setPendingCodeTask(ctx.senderNumber, t, dir);
        return {
          staged: true,
          task: t,
          cwd: dir,
          instruction:
            "Tampilkan task dan direktori ini persis ke owner dan minta konfirmasi ('ya' untuk jalan, 'batal' " +
            "untuk batal). JANGAN bilang sudah dijalankan — belum, dan proses ini bisa makan waktu beberapa menit.",
        };
      },
    },
  ];
}
