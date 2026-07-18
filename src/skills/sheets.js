import { google } from "googleapis";
import { getAuthorizedClient, isGoogleConnected } from "../google.js";

const auth = () => getAuthorizedClient();

function friendlyError(err) {
  if (err?.code === 403 || err?.response?.status === 403) {
    return {
      error:
        "akses Google Sheets belum diizinkan — pemilik bot perlu Disconnect lalu Connect ulang Google " +
        "di dashboard supaya izin Sheets ikut diberikan",
    };
  }
  return { error: err.message };
}

// Users refer to spreadsheets by name ("spreadsheet pengeluaran"), not id —
// resolve via Drive search, most recently modified match wins.
async function resolveSpreadsheet(name) {
  const q = String(name ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const res = await google.drive({ version: "v3", auth: auth() }).files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and name contains '${q}'`,
    fields: "files(id, name, webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: 5,
  });
  const files = res.data.files ?? [];
  if (files.length === 0) return { error: `spreadsheet "${name}" tidak ditemukan di Drive` };
  return { file: files[0], alternatives: files.slice(1).map((f) => f.name) };
}

async function readSheet(spreadsheetName, range) {
  const found = await resolveSpreadsheet(spreadsheetName);
  if (found.error) return found;
  const sheets = google.sheets({ version: "v4", auth: auth() });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: found.file.id, fields: "sheets(properties(title))" });
  const firstTab = meta.data.sheets?.[0]?.properties?.title ?? "Sheet1";
  const effectiveRange = range || `${firstTab}!A1:Z200`;

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: found.file.id, range: effectiveRange });
  return {
    spreadsheet: found.file.name,
    link: found.file.webViewLink,
    tabs: meta.data.sheets.map((s) => s.properties.title),
    range: effectiveRange,
    rows: (res.data.values ?? []).slice(0, 200),
  };
}

async function appendRow(spreadsheetName, values, tab) {
  const found = await resolveSpreadsheet(spreadsheetName);
  if (found.error) return found;
  const sheets = google.sheets({ version: "v4", auth: auth() });

  let target = tab;
  if (!target) {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: found.file.id, fields: "sheets(properties(title))" });
    target = meta.data.sheets?.[0]?.properties?.title ?? "Sheet1";
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: found.file.id,
    range: `${target}!A:A`,
    valueInputOption: "USER_ENTERED", // so "18/7/2026" and "50000" become real dates/numbers
    requestBody: { values: [values.map((v) => String(v))] },
  });
  return { ok: true, spreadsheet: found.file.name, tab: target, appended: values, link: found.file.webViewLink };
}

async function createSheet(title, headers, rows) {
  const sheets = google.sheets({ version: "v4", auth: auth() });

  // No `fields` mask here: unlike Drive, Sheets' spreadsheets.create rejects
  // the fields parameter outright with 400 INVALID_ARGUMENT.
  const res = await sheets.spreadsheets.create({
    requestBody: { properties: { title }, sheets: [{ properties: { title: "Sheet1" } }] },
  });
  const spreadsheetId = res.data.spreadsheetId;

  const values = [...(headers?.length ? [headers] : []), ...(rows ?? [])];
  if (values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: values.map((r) => r.map((v) => String(v))) },
    });
  }

  // Same as docs.js: private to the creator by default, but this is a
  // "share a link via WhatsApp" feature, so make it viewable by anyone with
  // the link.
  await google
    .drive({ version: "v3", auth: auth() })
    .permissions.create({ fileId: spreadsheetId, requestBody: { role: "reader", type: "anyone" } });

  return { ok: true, url: res.data.spreadsheetUrl };
}

async function updateSheet(spreadsheetName, values, { tab, range, clear } = {}) {
  const found = await resolveSpreadsheet(spreadsheetName);
  if (found.error) return found;
  const sheets = google.sheets({ version: "v4", auth: auth() });
  const spreadsheetId = found.file.id;

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title))" });
  const tabs = meta.data.sheets.map((s) => s.properties.title);
  let target = tab || tabs[0] || "Sheet1";

  // "Put the budget in its own tab" should work without a separate tool —
  // create the tab on the fly when it doesn't exist yet.
  if (!tabs.includes(target)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: target } } }] },
    });
  } else if (clear) {
    await sheets.spreadsheets.values.clear({ spreadsheetId, range: target });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${target}!${range || "A1"}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: values.map((r) => r.map((v) => String(v))) },
  });
  return { ok: true, spreadsheet: found.file.name, tab: target, link: found.file.webViewLink };
}

export function skills() {
  if (!isGoogleConnected()) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "create_google_sheet",
          description:
            "Create a brand NEW Google Sheets spreadsheet with an optional header row and initial data rows, " +
            "and get a shareable link. Use for 'buatin spreadsheet baru ...', 'bikin tabel buat ...'. NOT for " +
            "adding to a spreadsheet that already exists — use append_sheet_row for that instead.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Spreadsheet title" },
              headers: { type: "array", items: { type: "string" }, description: "Optional column header row" },
              rows: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
                description: "Optional initial data rows, each an array of cell values in column order",
              },
            },
            required: ["title"],
          },
        },
      },
      execute: ({ title, headers, rows }) => createSheet(title, headers, rows).catch(friendlyError),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "update_sheet",
          description:
            "Write/rewrite data in an EXISTING Google Sheets spreadsheet (found by approximate name): " +
            "replace or restructure its contents, fill a specific range, or write into a specific tab " +
            "(the tab is created automatically if it doesn't exist — great for adding e.g. a 'Budget' tab " +
            "to an existing spreadsheet instead of creating a whole new file). Use this when improving or " +
            "extending a spreadsheet that was already created, instead of create_google_sheet.",
          parameters: {
            type: "object",
            properties: {
              spreadsheet: { type: "string", description: "Spreadsheet name (approximate ok)" },
              values: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
                description: "2D array of rows to write, each an array of cell values (include the header row when rewriting)",
              },
              tab: { type: "string", description: "Optional tab name; default = first tab. Created if missing." },
              range: { type: "string", description: "Optional A1 start cell within the tab, default A1" },
              clear: { type: "boolean", description: "true = clear the tab first (full rewrite instead of overlay)" },
            },
            required: ["spreadsheet", "values"],
          },
        },
      },
      execute: ({ spreadsheet, values, tab, range, clear }) =>
        updateSheet(spreadsheet, values ?? [], { tab, range, clear }).catch(friendlyError),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_sheet",
          description:
            "Read data from a Google Sheets spreadsheet in the user's Drive, found by (approximate) name. " +
            "Use for 'isi spreadsheet pengeluaran apa aja?', 'total di sheet X berapa?'.",
          parameters: {
            type: "object",
            properties: {
              spreadsheet: { type: "string", description: "Spreadsheet name (approximate ok)" },
              range: { type: "string", description: "Optional A1 range incl. tab, e.g. 'Sheet1!A1:D50'. Default: first tab A1:Z200" },
            },
            required: ["spreadsheet"],
          },
        },
      },
      execute: ({ spreadsheet, range }) => readSheet(spreadsheet, range).catch(friendlyError),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "append_sheet_row",
          description:
            "Append one row to a Google Sheets spreadsheet (found by name). Perfect for logging " +
            "structured entries from chat, e.g. 'catat pengeluaran 50rb makan siang' -> " +
            "append_sheet_row(spreadsheet: 'pengeluaran', values: ['18/07/2026', 'makan siang', 50000]). " +
            "Read the sheet first if unsure about the column order.",
          parameters: {
            type: "object",
            properties: {
              spreadsheet: { type: "string", description: "Spreadsheet name (approximate ok)" },
              values: { type: "array", items: { type: "string" }, description: "Cell values, one per column, in column order" },
              tab: { type: "string", description: "Optional tab name; default = first tab" },
            },
            required: ["spreadsheet", "values"],
          },
        },
      },
      execute: ({ spreadsheet, values, tab }) => appendRow(spreadsheet, values ?? [], tab).catch(friendlyError),
    },
  ];
}
