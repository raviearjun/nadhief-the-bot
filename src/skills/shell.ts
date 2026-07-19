import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * DANGER SKILL — full shell on the VPS, sudo included (the bot's user has
 * NOPASSWD sudo, so no password is stored anywhere). Exposed ONLY to the
 * owner and ONLY in a DM (never in a group, where other people's messages,
 * web-search results and photo text all flow into the model's context and
 * would be a direct prompt-injection path to root).
 *
 * The model NEVER executes directly. run_shell_command only *stages* the
 * command; the handler runs it solely after the owner's next message passes
 * a deterministic confirmation check in code (see isConfirmation) — so a
 * hallucinated "confirmed!" from the model can't trigger execution.
 */

const EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 3_500;
const PENDING_TTL_MS = 5 * 60_000;

const pending = new Map(); // senderNumber -> { command, at }

export function setPendingCommand(senderNumber, command) {
  pending.set(senderNumber, { command, at: Date.now() });
}

export function getPendingCommand(senderNumber) {
  const p = pending.get(senderNumber);
  if (!p) return null;
  if (Date.now() - p.at > PENDING_TTL_MS) {
    pending.delete(senderNumber);
    return null;
  }
  return p.command;
}

export function clearPendingCommand(senderNumber) {
  pending.delete(senderNumber);
}

// Deterministic yes/no — must be a short, unambiguous affirmation on its own,
// not a sentence that merely contains "ya".
export function isConfirmation(text) {
  return /^(ya|iya|gas|ok|oke|okay|lanjut|jalankan|jalan|confirm|yes|y|betul|bener|sip)\b[.! ]*$/i.test(text.trim());
}

export function isCancellation(text) {
  return /^(no|ga|gak|nggak|batal|cancel|jangan|stop|tidak)\b[.! ]*$/i.test(text.trim());
}

export async function executeCommand(command) {
  try {
    const { stdout, stderr } = await run("bash", ["-lc", command], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
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

// Owner-only AND DM-only. Both conditions matter (see file header).
export function skills(ctx) {
  if (!ctx.isOwner || ctx.isGroup) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "run_shell_command",
          description:
            "Stage a shell command to run on the VPS this bot lives on (Ubuntu, user revaldyas, sudo works " +
            "without a password). Use when the owner asks you to do something on the server: check/edit files, " +
            "manage services, install packages, inspect logs, etc. IMPORTANT: this does NOT run the command " +
            "immediately — it stages it. After calling this, show the exact command to the owner and ask them " +
            "to confirm; the system runs it only once they reply 'ya'/'gas'. Compose the full command yourself " +
            "(pipes, sudo, etc. all allowed).",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The exact shell command to run" },
            },
            required: ["command"],
          },
        },
      },
      execute: ({ command }) => {
        const cmd = String(command ?? "").trim();
        if (!cmd) return { error: "perintah kosong" };
        setPendingCommand(ctx.senderNumber, cmd);
        return {
          staged: true,
          command: cmd,
          instruction:
            "Tampilkan perintah ini persis ke owner dan minta konfirmasi ('ya' untuk jalan, 'batal' untuk " +
            "batal). JANGAN bilang perintah sudah dijalankan — belum.",
        };
      },
    },
  ];
}
