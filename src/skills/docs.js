import { google } from "googleapis";
import { Readable } from "node:stream";
import { getAuthorizedClient, isGoogleConnected } from "../google.js";

function driveClient() {
  return google.drive({ version: "v3", auth: getAuthorizedClient() });
}

async function createDoc({ title, content, format }) {
  const drive = driveClient();
  const mimeType = format === "html" ? "text/html" : "text/plain";

  // Uploading as text/html or text/plain with a Google Docs target mimeType
  // makes Drive auto-convert it into a native, editable Google Doc.
  const res = await drive.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.document" },
    media: { mimeType, body: Readable.from([content]) },
    fields: "id, webViewLink",
  });

  // Files are private to the creator by default — this is a "share a link
  // via WhatsApp" feature, so make it viewable by anyone with the link.
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: "reader", type: "anyone" },
  });

  return { ok: true, url: res.data.webViewLink };
}

export function skills() {
  if (!isGoogleConnected()) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "create_google_doc",
          description:
            "Create a Google Doc with the given content and get a shareable view link (anyone with the " +
            "link can view). Use when asked to make a document/notes/writeup they can open in a browser " +
            "or share with others ('buatin dokumen...', 'bikin file berisi...', 'tulis ... jadi doc').",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Document title" },
              content: { type: "string", description: "The document content" },
              format: { type: "string", enum: ["text", "html"], description: "Content format, default text" },
            },
            required: ["title", "content"],
          },
        },
      },
      execute: ({ title, content, format }) =>
        createDoc({ title, content, format }).catch((err) => ({ error: err.message })),
    },
  ];
}
