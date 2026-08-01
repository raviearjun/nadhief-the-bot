import { Daytona } from "@daytona/sdk";
import { config } from "../config.js";
import { logLlmUsage } from "../db.js";

/**
 * Build & host a web app in an isolated Daytona sandbox and return a public
 * preview URL. Unlike build_app (which runs Claude Code on the production VPS),
 * this generates the app from files the model provides, writes them into a
 * fresh sandbox, starts the server, and exposes it via Daytona's preview link —
 * fully off the production VPS. The sandbox is kept running so the app stays up.
 * Disabled unless DAYTONA_API_KEY is set.
 */

const INSTALL_TIMEOUT_SEC = 180;

async function buildAppDaytona(ctx, { files, install, start_command, port }: any) {
  if (!Array.isArray(files) || files.length === 0) return { error: "files kosong — sediakan minimal index.html" };
  const p = Number(port) || 3000;
  // Default: serve the files as a static site (covers landing pages / profiles).
  const startCmd = (start_command && String(start_command).trim()) || `python3 -m http.server ${p} --bind 0.0.0.0`;
  logLlmUsage("daytona_build_app", null);

  const daytona = new Daytona({ apiKey: config.daytonaApiKey });
  let sandbox: any;
  try {
    sandbox = await daytona.create();

    for (const f of files) {
      if (!f?.path) continue;
      const path = String(f.path).replace(/^\/+/, "");
      const slash = path.lastIndexOf("/");
      if (slash > 0) await sandbox.fs.createFolder(path.slice(0, slash), "755").catch(() => {});
      await sandbox.fs.uploadFile(Buffer.from(String(f.content ?? ""), "utf8"), path);
    }

    if (install) {
      await sandbox.process.executeCommand("npm install", undefined, undefined, INSTALL_TIMEOUT_SEC).catch(() => {});
    }

    // Start the server in a background session so it keeps running.
    const sid = "webapp";
    await sandbox.process.createSession(sid);
    await sandbox.process.executeSessionCommand(sid, { command: startCmd, runAsync: true });
    await new Promise((r) => setTimeout(r, 4000)); // give the server a moment to bind

    const preview = await sandbox.getPreviewLink(p);
    // The plain preview URL needs the sandbox auth token; pass it as a query
    // param so the link opens directly in a browser (permanent, no expiry —
    // unlike getSignedPreviewUrl which maxes out at 24h).
    const url = preview.token ? `${preview.url}?DAYTONA_SANDBOX_AUTH_KEY=${preview.token}` : preview.url;
    return {
      ok: true,
      url,
      sandbox_id: sandbox.id,
      note: "App live di Daytona sandbox (terpisah dari VPS). Kirim URL lengkapnya (dengan token) ke user apa adanya.",
    };
  } catch (e: any) {
    if (sandbox) sandbox.delete().catch(() => {}); // clean up only on failure
    return { error: `gagal build di Daytona: ${e.message}` };
  }
}

export function skills(ctx) {
  if (!config.daytonaApiKey) return [];
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "build_app_daytona",
          description:
            "Build & host web/app di sandbox Daytona yang TERISOLASI (terpisah dari VPS produksi) lalu balikin " +
            "PREVIEW URL publik. KAMU yang menulis seluruh isi file-nya (mis. index.html self-contained untuk " +
            "landing page/company profile; atau app Node dengan server.js + package.json). Cocok untuk 'buatin " +
            "website/landing page/company profile'. Kalau tool `build_app` (VPS) JUGA tersedia dan user belum " +
            "menyebut platform, TANYA DULU ke user: 'mau di-build di VPS atau Daytona?' — jangan langsung panggil " +
            "salah satu. Setelah app jadi, kirim URL-nya ke user. Server WAJIB listen di 0.0.0.0.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Nama/judul app (buat referensi)." },
              files: {
                type: "array",
                description: "Semua file app. Untuk landing page cukup satu index.html self-contained (CSS/JS inline).",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string", description: "Path relatif file, mis. 'index.html' atau 'server.js'." },
                    content: { type: "string", description: "Isi lengkap file." },
                  },
                  required: ["path", "content"],
                },
              },
              port: { type: "integer", description: "Port yang didengarkan server. Default 3000." },
              start_command: {
                type: "string",
                description:
                  "Perintah start server (listen di 0.0.0.0 pada port di atas). KOSONGKAN untuk situs statis " +
                  "(otomatis disajikan via python http.server). Untuk app Node: mis. 'node server.js'.",
              },
              install: { type: "boolean", description: "Set true kalau ada package.json yang perlu 'npm install' dulu." },
            },
            required: ["files"],
          },
        },
      },
      execute: (args: any) => buildAppDaytona(ctx, args || {}),
    },
  ];
}
