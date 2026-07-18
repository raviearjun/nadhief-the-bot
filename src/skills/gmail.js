import { google } from "googleapis";
import { getAuthorizedClient, isGoogleConnected } from "../google.js";

function gmailClient() {
  return google.gmail({ version: "v1", auth: getAuthorizedClient() });
}

function friendlyError(err) {
  if (err?.code === 403 || err?.response?.status === 403) {
    return {
      error:
        "akses Gmail belum diizinkan — pemilik bot perlu Disconnect lalu Connect ulang Google " +
        "di dashboard supaya izin Gmail ikut diberikan",
    };
  }
  return { error: err.message };
}

const MAX_BODY_CHARS = 6000;

const b64decode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

// Gmail bodies are a MIME tree; prefer the first text/plain leaf, fall back
// to stripped text/html.
function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return b64decode(payload.body.data);
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return b64decode(payload.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  for (const part of payload.parts ?? []) {
    const body = extractBody(part);
    if (body) return body;
  }
  return "";
}

const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;

async function searchEmails(query, maxResults) {
  const gmail = gmailClient();
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query || "in:inbox",
    maxResults: Math.min(Math.max(Number(maxResults) || 8, 1), 20),
  });
  const ids = (list.data.messages ?? []).map((m) => m.id);
  const emails = [];
  for (const id of ids) {
    const { data } = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
    emails.push({
      id,
      from: header(data, "from"),
      subject: header(data, "subject"),
      date: header(data, "date"),
      snippet: data.snippet,
      unread: (data.labelIds ?? []).includes("UNREAD"),
    });
  }
  return { emails };
}

async function readEmail(messageId) {
  const { data } = await gmailClient().users.messages.get({ userId: "me", id: messageId, format: "full" });
  const body = extractBody(data.payload);
  return {
    from: header(data, "from"),
    to: header(data, "to"),
    subject: header(data, "subject"),
    date: header(data, "date"),
    body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + "\n[...dipotong]" : body,
  };
}

async function sendEmail(to, subject, body) {
  // RFC 2822 message; base64url-encoded per the Gmail API contract.
  // Subject is RFC 2047-encoded so non-ASCII (emoji, accents) survives.
  const raw = Buffer.from(
    `To: ${to}\r\n` +
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n\r\n` +
      body
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const { data } = await gmailClient().users.messages.send({ userId: "me", requestBody: { raw } });
  return { ok: true, message_id: data.id };
}

export function skills() {
  if (!isGoogleConnected()) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "search_emails",
          description:
            "Search the connected Gmail inbox. Supports Gmail query syntax " +
            "(e.g. 'is:unread', 'from:boss@x.com', 'invoice newer_than:7d'). " +
            "Use for 'ada email penting gak?', 'cek email dari X'.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Gmail search query; empty = inbox terbaru" },
              max_results: { type: "number", description: "Max emails, default 8" },
            },
          },
        },
      },
      execute: ({ query, max_results }) => searchEmails(query, max_results).catch(friendlyError),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_email",
          description: "Read the full body of one email. Use search_emails first to get the message id.",
          parameters: {
            type: "object",
            properties: { message_id: { type: "string" } },
            required: ["message_id"],
          },
        },
      },
      execute: ({ message_id }) => readEmail(message_id).catch(friendlyError),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "send_email",
          description:
            "Send a plain-text email from the connected Gmail account. IMPORTANT: only call this after " +
            "the user has explicitly confirmed the recipient, subject, and body — show them a draft first " +
            "and wait for their go-ahead. Never send on your own initiative.",
          parameters: {
            type: "object",
            properties: {
              to: { type: "string", description: "Recipient email address" },
              subject: { type: "string" },
              body: { type: "string", description: "Plain-text email body" },
            },
            required: ["to", "subject", "body"],
          },
        },
      },
      execute: ({ to, subject, body }) => sendEmail(to, subject, body).catch(friendlyError),
    },
  ];
}
