import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Owner-only server health check. Deliberately NOT a shell: every command is
 * a fixed argv executed via execFile (no shell interpolation), and the LLM
 * has no parameter that reaches the command line — so neither a hallucination
 * nor a prompt injection from group members/web content/photo text can make
 * the bot run anything else. That's the deal: "john cek server" works,
 * arbitrary command execution doesn't exist.
 */

const EXEC_TIMEOUT_MS = 5_000;

async function tryCmd(cmd, args) {
  try {
    const { stdout } = await run(cmd, args, { timeout: EXEC_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    return `(gagal: ${err.code ?? err.message})`;
  }
}

async function serverStatus() {
  const upSec = os.uptime();
  const days = Math.floor(upSec / 86400);
  const hours = Math.floor((upSec % 86400) / 3600);

  const [disk, service, since] = await Promise.all([
    tryCmd("df", ["-h", "/"]),
    tryCmd("systemctl", ["is-active", "wabot"]),
    tryCmd("systemctl", ["show", "wabot", "--property=ActiveEnterTimestamp", "--value"]),
  ]);

  return {
    uptime: `${days} hari ${hours} jam`,
    load_avg_1m_5m_15m: os.loadavg().map((n) => n.toFixed(2)),
    cpu_cores: os.cpus().length,
    ram: `${((os.totalmem() - os.freemem()) / 1e9).toFixed(1)} GB dipakai dari ${(os.totalmem() / 1e9).toFixed(1)} GB`,
    disk_root: disk.split("\n").pop(),
    wabot_service: service,
    wabot_running_since: since,
    hostname: os.hostname(),
  };
}

// Owner-only: server internals are nobody else's business.
export function skills(ctx) {
  if (!ctx.isOwner) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "get_server_status",
          description:
            "Health snapshot of the VPS this bot runs on: uptime, CPU load, RAM, root disk usage, and the " +
            "bot service's state. Read-only, fixed diagnostics — there is deliberately no way to run other " +
            "commands. Use when the owner asks 'cek server', 'server aman?', 'RAM sisa berapa?'.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: () => serverStatus().catch((err) => ({ error: err.message })),
    },
  ];
}
