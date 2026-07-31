import { Daytona } from "@daytona/sdk";
import { config } from "../config.js";
import { logLlmUsage } from "../db.js";

/**
 * Run code in a disposable, fully-isolated Daytona sandbox and return its
 * output. Lets the bot actually COMPUTE / process data instead of guessing —
 * math, data analysis (e.g. an Excel/CSV the user just sent), transforms,
 * quick scripts. Any matplotlib figures the code produces are captured and
 * sent back into the chat as images. Safe: the code never touches the
 * production VPS, and the sandbox is deleted right after. Disabled unless
 * DAYTONA_API_KEY is set.
 */

const EXEC_TIMEOUT_SEC = 60;
const MAX_OUTPUT = 4000;

// matplotlib chart capture (Daytona's own artifacts.charts stays empty on the
// default sandbox). Only injected when the code actually uses matplotlib, to
// keep other runs fast. The prologue forces a headless backend and patches
// plt.show() to snapshot + close figures (plt.show() otherwise closes them
// before we can read them); the epilogue catches figures that were never
// shown, then prints each as a base64 PNG marker on stdout.
const CHART_PROLOGUE = `
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as _p
    import io as _io, base64 as _b64
    _charts = []
    def _cap():
        for _n in _p.get_fignums():
            _b = _io.BytesIO(); _p.figure(_n).savefig(_b, format="png", bbox_inches="tight")
            _charts.append(_b64.b64encode(_b.getvalue()).decode())
        _p.close("all")
    _p.show = lambda *a, **k: _cap()
except Exception:
    _charts = None
`;
const CHART_EPILOGUE = `
try:
    if _charts is not None:
        _cap()
        for _c in _charts:
            print("__CHART_PNG__" + _c)
except Exception:
    pass
`;
const usesMatplotlib = (code: string) => /matplotlib|pyplot|seaborn|\bplt\b/.test(code);

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
  const isPython = !shell && codeLang === "python";
  const daytona = new Daytona({ apiKey: config.daytonaApiKey });
  let sandbox: any;
  try {
    sandbox = await daytona.create(shell ? undefined : { language: codeLang });
    const withCharts = isPython && usesMatplotlib(code);
    const finalCode = withCharts ? `${CHART_PROLOGUE}\n${code}\n${CHART_EPILOGUE}` : code;
    const resp = shell
      ? await sandbox.process.executeCommand(code, undefined, undefined, EXEC_TIMEOUT_SEC)
      : await sandbox.process.codeRun(finalCode, undefined, EXEC_TIMEOUT_SEC);

    let out = String(resp.result ?? resp.artifacts?.stdout ?? "");

    // Pull out chart PNGs the epilogue printed, send them as images, and strip
    // those marker lines from the text output.
    let chartsSent = 0;
    if (isPython && out.includes("__CHART_PNG__")) {
      const kept: string[] = [];
      for (const line of out.split("\n")) {
        const m = line.match(/^__CHART_PNG__(.+)$/);
        if (m) {
          try {
            await ctx.sock.sendMessage(ctx.chatJid, { image: Buffer.from(m[1], "base64"), caption: "grafik" });
            chartsSent++;
          } catch {}
        } else {
          kept.push(line);
        }
      }
      out = kept.join("\n");
    }

    out = out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) + "\n…(output dipotong)" : out;
    return {
      exitCode: resp.exitCode,
      output: out.trim() || (chartsSent ? "(grafik terkirim, tanpa output teks)" : "(tidak ada output teks)"),
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
              code: { type: "string", description: "Kode lengkap yang siap dijalankan. Pakai print()/console.log() untuk output. Untuk grafik: pakai matplotlib biasa (plt.bar/plot/...); tidak perlu savefig — figure otomatis dikirim." },
            },
            required: ["code"],
          },
        },
      },
      execute: (args: any) => runCode(ctx, args || {}),
    },
  ];
}
