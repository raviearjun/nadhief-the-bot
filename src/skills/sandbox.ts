import { Daytona } from "@daytona/sdk";
import { config } from "../config.js";
import { logLlmUsage } from "../db.js";

/**
 * Run code in a disposable, fully-isolated Daytona sandbox and return its
 * output. Lets the bot actually COMPUTE / process data instead of guessing —
 * math, data analysis (e.g. an Excel/CSV the user just sent), transforms,
 * quick scripts. matplotlib charts produced by the code are sent back into the
 * chat as images. Safe: the code never touches the production VPS, and the
 * sandbox is deleted right after. Disabled unless DAYTONA_API_KEY is set.
 */

const EXEC_TIMEOUT_SEC = 60;
const MAX_OUTPUT = 4000;

function langToCode(language = "python"): { shell: boolean; codeLang: string } {
  const l = String(language).toLowerCase();
  if (["bash", "shell", "sh"].includes(l)) return { shell: true, codeLang: "" };
  if (["javascript", "js", "node"].includes(l)) return { shell: false, codeLang: "javascript" };
  if (["typescript", "ts"].includes(l)) return { shell: false, codeLang: "typescript" };
  return { shell: false, codeLang: "python" };
}

async function runCode(ctx, { language, code }: any) {
  if (!code || !String(code).trim()) return { error: "code kosong — tulis kode yang mau dijalankan" };
  logLlmUsage("daytona_run_code", null); // call-count visibility; Daytona billed separately

  const { shell, codeLang } = langToCode(language);
  const daytona = new Daytona({ apiKey: config.daytonaApiKey });
  let sandbox: any;
  try {
    sandbox = await daytona.create(shell ? undefined : { language: codeLang });
    const resp = shell
      ? await sandbox.process.executeCommand(code, undefined, undefined, EXEC_TIMEOUT_SEC)
      : await sandbox.process.codeRun(code, undefined, EXEC_TIMEOUT_SEC);

    // Send any matplotlib charts straight into the chat as images.
    let chartsSent = 0;
    for (const ch of resp.artifacts?.charts ?? []) {
      if (ch?.png) {
        try {
          await ctx.sock.sendMessage(ctx.chatJid, { image: Buffer.from(ch.png, "base64"), caption: ch.title || "grafik" });
          chartsSent++;
        } catch {}
      }
    }

    const out = String(resp.result ?? resp.artifacts?.stdout ?? "");
    const output = out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + "\n…(output dipotong)" : out;
    return {
      exitCode: resp.exitCode,
      output: output || "(tidak ada output teks)",
      ...(chartsSent ? { charts_sent: chartsSent } : {}),
    };
  } catch (e: any) {
    return { error: `gagal menjalankan kode di sandbox: ${e.message}` };
  } finally {
    if (sandbox) sandbox.delete().catch(() => {});
  }
}

export function skills(ctx) {
  if (!config.daytonaApiKey) return [];
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "run_code",
          description:
            "Jalankan kode (Python/JavaScript/TypeScript/Bash) di sandbox TERISOLASI & sekali pakai lalu balikin " +
            "outputnya. Pakai kalau butuh EKSEKUSI nyata: hitung/olah angka, analisa data (mis. isi Excel/CSV yang " +
            "baru dikirim user), transformasi teks, cek logika/algoritma, atau bikin GRAFIK (pakai matplotlib — " +
            "grafiknya otomatis dikirim sebagai gambar ke chat). KAMU yang menulis kodenya dari permintaan user. " +
            "Untuk output teks, WAJIB pakai print()/console.log(). Jangan pakai untuk hal yang bisa dijawab langsung " +
            "tanpa menjalankan kode.",
          parameters: {
            type: "object",
            properties: {
              language: { type: "string", enum: ["python", "javascript", "typescript", "bash"], description: "Bahasa. Default python (paling lengkap untuk data/plot)." },
              code: { type: "string", description: "Kode lengkap yang siap dijalankan. Pakai print()/console.log() untuk output. Untuk grafik: matplotlib, cukup plt.show() (jangan simpan file)." },
            },
            required: ["code"],
          },
        },
      },
      execute: (args: any) => runCode(ctx, args || {}),
    },
  ];
}
