import { google } from "googleapis";
import { getAuthorizedClient, isGoogleConnected } from "../google.js";

function driveClient() {
  return google.drive({ version: "v3", auth: getAuthorizedClient() });
}

// Reading the whole Drive needs the drive.readonly scope, which older
// connections (made before it was added) don't have — surface that as an
// actionable message instead of a bare 403.
function friendlyError(err) {
  if (err?.code === 403 || err?.response?.status === 403) {
    return {
      error:
        "akses baca Google Drive belum diizinkan — pemilik bot perlu Disconnect lalu Connect ulang " +
        "Google di dashboard (tab Calendar) supaya izin baru (baca Drive) ikut diberikan",
    };
  }
  return { error: err.message };
}

// Google-native files have no downloadable content — they must be exported.
const EXPORT_MIME = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

// Keep tool results small enough to not blow up the chat context.
const MAX_CONTENT_CHARS = 8000;

async function searchFiles(query, maxResults) {
  const q = String(query ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const res = await driveClient().files.list({
    q: `trashed = false and (name contains '${q}' or fullText contains '${q}')`,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink, owners(displayName))",
    orderBy: "modifiedTime desc",
    pageSize: Math.min(Math.max(Number(maxResults) || 10, 1), 25),
  });
  return {
    files: (res.data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.mimeType,
      modified: f.modifiedTime,
      link: f.webViewLink,
      owner: f.owners?.[0]?.displayName ?? null,
    })),
  };
}

async function readFile(fileId) {
  const drive = driveClient();
  const meta = await drive.files.get({ fileId, fields: "id, name, mimeType, webViewLink" });
  const { name, mimeType, webViewLink } = meta.data;

  let content;
  const exportMime = EXPORT_MIME[mimeType];
  if (exportMime) {
    const res = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: "text" });
    content = res.data;
  } else if (/^text\/|json|xml|csv/.test(mimeType)) {
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    content = res.data;
  } else {
    return {
      name,
      type: mimeType,
      link: webViewLink,
      error: "file jenis ini tidak bisa dibaca sebagai teks (misal PDF/gambar) — kirim link-nya saja ke user",
    };
  }

  content = String(content ?? "");
  const truncated = content.length > MAX_CONTENT_CHARS;
  return {
    name,
    type: mimeType,
    link: webViewLink,
    content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content,
    ...(truncated ? { note: `content truncated to first ${MAX_CONTENT_CHARS} chars` } : {}),
  };
}

export function skills() {
  if (!isGoogleConnected()) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "search_drive_files",
          description:
            "Search the connected Google Drive by file name or content ('cari di gdrive', 'ada file feedback gak?'). " +
            "Returns file ids, names, and links; use read_drive_file with an id to read one.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search keywords (matched against file names and full text)" },
              max_results: { type: "number", description: "Max files to return, default 10" },
            },
            required: ["query"],
          },
        },
      },
      execute: ({ query, max_results }) => searchFiles(query, max_results).catch(friendlyError),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_drive_file",
          description:
            "Read the text content of a Google Drive file (Google Docs/Sheets/Slides are exported as text; " +
            "plain text/CSV/JSON files are downloaded). Use search_drive_files first to get the file id.",
          parameters: {
            type: "object",
            properties: {
              file_id: { type: "string", description: "File id from search_drive_files" },
            },
            required: ["file_id"],
          },
        },
      },
      execute: ({ file_id }) => readFile(file_id).catch(friendlyError),
    },
  ];
}
