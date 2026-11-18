import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageID,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import QRCode from "qrcode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { notePresenceUpdate } from "./typing.js";
import { rememberBotMessage } from "./botsent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, "..", "..", "auth_info");

export const waState = {
  status: "disconnected", // disconnected | connecting | qr | connected
  qrDataUrl: null,
  ownJid: null,
  ownLid: null, // privacy LID — groups often reference the bot by this, not the phone jid
};

let sock = null;

// Human-readable names for Baileys disconnect status codes, so the journal
// shows WHY the connection dropped (conflict vs timeout vs server restart)
// instead of just "connection closed".
const DISCONNECT_NAMES = Object.fromEntries(Object.entries(DisconnectReason).map(([name, code]) => [code, name]));

// Reconnect backoff: an immediate retry is right for a one-off drop, but a
// persistent failure (server rejecting us, conflict with another session)
// must not turn into a reconnect storm — seen in the logs as ~20 drops in
// 30s. Delay grows per consecutive failure and resets once a connection
// actually opens.
let reconnectAttempts = 0;

function reconnectDelayMs() {
  return Math.min(1000 * 2 ** reconnectAttempts, 60_000);
}

export async function startWhatsApp(onMessage) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  waState.status = "connecting";
  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["WA Personal Bot", "Chrome", "1.0"],
   
    keepAliveIntervalMs: 25_000,
  });

  // Single choke point for every outgoing message (handler, skills, scheduler):
  // pick the message ID ourselves and record it before sending, so the handler
  // can later tell the bot's own messages from the owner's manual typing.
  const rawSend = sock.sendMessage.bind(sock);
  (sock as any).sendMessage = (jid, content, options: any = {}) => {
    const messageId = options.messageId ?? generateMessageID();
    rememberBotMessage(messageId);
    return rawSend(jid, content, { ...options, messageId });
  };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waState.status = "qr";
      waState.qrDataUrl = await QRCode.toDataURL(qr);
    }

    if (connection === "open") {
      waState.status = "connected";
      waState.qrDataUrl = null;
      waState.ownJid = sock.user?.id ?? null;
      waState.ownLid = sock.user?.lid ?? null;
      reconnectAttempts = 0;
      console.log("[wa] connected as", waState.ownJid, waState.ownLid ? `(lid ${waState.ownLid})` : "");
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(
        `[wa] connection closed: status=${statusCode} (${DISCONNECT_NAMES[statusCode] ?? "unknown"}), ` +
          `message=${JSON.stringify(lastDisconnect?.error?.message ?? null)}, loggedOut=${loggedOut}`
      );

      waState.status = "disconnected";
      waState.qrDataUrl = null;
      waState.ownJid = null;
      waState.ownLid = null;

      if (loggedOut) {
        // Device was removed/unlinked from the phone — old creds are dead.
        // Wipe them and reconnect so a fresh QR gets generated automatically.
        await rm(AUTH_DIR, { recursive: true, force: true }).catch(() => {});
      }

      const delay = reconnectDelayMs();
      reconnectAttempts += 1;
      console.log(`[wa] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      setTimeout(() => startWhatsApp(onMessage), delay);
    }
  });

  sock.ev.on("presence.update", (update) => {
    try {
      notePresenceUpdate(update);
    } catch {}
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      if (!m.message) continue;
      // Normally only live ("notify") messages are processed. The owner's own
      // fresh manual messages are also accepted as "append" (a very recent
      // timestamp rules out history sync); the bot's own echoes are filtered
      // out in the handler via the recorded message IDs.
      if (type !== "notify") {
        const ts = Number((m.messageTimestamp as any)?.toNumber?.() ?? m.messageTimestamp ?? 0);
        const ageSec = Date.now() / 1000 - ts;
        if (!(m.key.fromMe && ageSec > -5 && ageSec < 30)) continue;
      }
      try {
        await onMessage(sock, m);
      } catch (err) {
        console.error("[wa] message handler error:", err);
      }
    }
  });

  return sock;
}

export function getSocket() {
  return sock;
}
