import { config } from "../config.js";
import {
  insertMessage,
  isWhitelisted,
  normalizeNumber,
  upsertLidMapping,
  getNumberForLid,
  addNote,
  getRecentMessages,
  getRecentHistory,
  addReminder,
  upsertFact,
  getFacts,
  upsertContact,
  getGroupChatsForPerson,
  getNotesForChats,
  getChatSettings,
  updateChatSettings,
  isRecentExchange,
} from "../db.js";
import { summarizeMessages, answerQuestion, analyzeMessage, extractLinks } from "../llm.js";
import { buildSkills } from "../skills/index.js";
import { isGoogleConnected } from "../google.js";
import { getSocket } from "./connection.js";
import { toWhatsAppFormat } from "../format.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_CMD_RE = /^\/remind\s+(\d+[smh]|\d{1,2}:\d{2})\s+(.+)$/i;
// Minimum gap between uninvited group interjections — the difference between
// "helpful" and "sok asik".
const UNSOLICITED_COOLDOWN_MS = 10 * 60_000;

// sock.sendMessage() to a group can internally hang fetching group metadata
// (seen on this server's flaky network) without ever resolving OR rejecting —
// a plain try/catch doesn't help there. Promise.race forces it to give up.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function parseDurationSpec(spec) {
  const relative = spec.match(/^(\d+)([smh])$/i);
  if (relative) {
    const n = Number(relative[1]);
    const mult = { s: 1000, m: 60_000, h: 3_600_000 }[relative[2].toLowerCase()];
    return Date.now() + n * mult;
  }
  const absolute = spec.match(/^(\d{1,2}):(\d{2})$/);
  if (absolute) {
    const [, hh, mm] = absolute;
    const target = new Date();
    target.setHours(Number(hh), Number(mm), 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  return null;
}

function getMessageText(m) {
  const msg = m.message;
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  );
}

function bareNumber(jid) {
  return jid?.split("@")[0]?.split(":")[0] ?? "";
}

function isMentioned(m, waState) {
  const mentioned = m.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  const ownIds = [waState.ownJid, waState.ownLid].filter(Boolean).map(bareNumber);
  if (mentioned.some((j) => ownIds.includes(bareNumber(j)))) return true;
  return getMessageText(m).toLowerCase().includes(config.botTriggerName);
}

// A swipe-reply to one of the bot's own messages is always addressed to the
// bot, trigger word or not. The quoted participant may be the bot's phone
// jid or its privacy lid depending on the chat — match either.
function isReplyToBot(m, waState) {
  let participant = null;
  for (const content of Object.values(m.message ?? {})) {
    if (content && typeof content === "object" && content.contextInfo?.participant) {
      participant = content.contextInfo.participant;
      break;
    }
  }
  if (!participant) return false;
  const ownIds = [waState.ownJid, waState.ownLid].filter(Boolean).map(bareNumber);
  return ownIds.includes(bareNumber(participant));
}

function stripTrigger(text) {
  const re = new RegExp(config.botTriggerName, "ig");
  return text.replace(re, "").replace(/^[,:\-\s]+/, "").trim();
}

function confirmReminder(message, fireAt) {
  return `⏰ Oke, aku ingetin "${message}" pada ${new Date(fireAt).toLocaleString("id-ID")}.`;
}

// Show "typing..." while the reply is being generated, as a sign the bot is
// alive. WhatsApp expires the composing state after ~10s, but an LLM+skills
// chain can run much longer — keep re-sending until stopped. Presence is
// best-effort: failures must never break the actual reply.
const TYPING_REFRESH_MS = 8_000;

function startTyping(getSock, chatJid) {
  const send = () => getSock()?.sendPresenceUpdate("composing", chatJid).catch(() => {});
  send();
  const interval = setInterval(send, TYPING_REFRESH_MS);
  return () => {
    clearInterval(interval);
    getSock()?.sendPresenceUpdate("paused", chatJid).catch(() => {});
  };
}

async function routeCommand(query, ctx) {
  const { chatJid, senderName, senderNumber, isGroup } = ctx;
  const lower = query.toLowerCase();

  // Proactive-mode controls, regex-based so they always work even when the
  // LLM is having a bad day. Scoped per group chat.
  if (isGroup) {
    // Short imperative only ("diem dulu", "kalem dong") — a longer sentence
    // containing the word ("kok diem aja sih?") is conversation, not a command.
    if (
      lower.length <= 25 &&
      /(^|\s)(diem|diam|kalem)\b/.test(lower) &&
      !/\b(kok|kenapa|knp|jangan|nggak|gak|ga)\b/.test(lower)
    ) {
      updateChatSettings(chatJid, { muted_until: Date.now() + 60 * 60_000 });
      return "Siap, John kalem dulu sejam 🤐 Kalau butuh, panggil nama John atau reply pesan John aja.";
    }
    if (/\bpasif\b/.test(lower)) {
      updateChatSettings(chatJid, { proactive: 0 });
      return "Oke, mode pasif: John cuma jawab kalau dipanggil atau di-reply di grup ini. 🫡";
    }
    if (/\b(proaktif|bangun|aktif lagi)\b/.test(lower)) {
      updateChatSettings(chatJid, { proactive: 1, muted_until: 0 });
      return "John aktif lagi! 😎 Siap nimbrung kalau ada yang bisa dibantu.";
    }
  }

  // Fast-path slash commands stay regex-based for reliability; everything
  // else goes to the LLM, which picks the right skill(s) itself.
  const remindMatch = query.match(REMINDER_CMD_RE);
  if (remindMatch) {
    const fireAt = parseDurationSpec(remindMatch[1]);
    if (!fireAt) return "Format gak dikenali. Contoh: /remind 10m beli tiket, atau /remind 15:00 meeting.";
    addReminder(chatJid, remindMatch[2], fireAt);
    return confirmReminder(remindMatch[2], fireAt);
  }

  if (lower.startsWith("/summary")) {
    const messages = getRecentMessages(chatJid, Date.now() - DAY_MS);
    return summarizeMessages(messages, { label: senderName });
  }

  if (lower.startsWith("/notes")) {
    const notes = getNotesForChats(ctx.relevantChatJids, 30);
    if (notes.length === 0) return "Belum ada catatan tersimpan.";
    return notes.map((n) => `• [${n.kind}] ${n.content}`).join("\n");
  }

  if (lower.startsWith("/help")) {
    return (
      "Aku bisa bantu banyak hal — tinggal ngobrol biasa:\n" +
      "• ⏰ Reminder: \"ingetin aku jam 3 meeting\" (sekali, harian, mingguan)\n" +
      "• ✅ Todo list: \"tambahin beli tiket ke todoku\", \"apa aja todoku?\"\n" +
      "• 📝 Catatan: \"catat alamat kantor: ...\", \"lihat catatan\"\n" +
      "• 🌦️ Cuaca: \"cuaca Bandung besok gimana?\"\n" +
      "• 🕌 Jadwal sholat: \"jadwal sholat Jakarta\"\n" +
      "• 💱 Kurs: \"100 USD berapa rupiah?\"\n" +
      "• 🎬 Bioskop: \"film apa aja di Bandung?\", \"Minions 3 tayang jam berapa?\"\n" +
      "• 🎥 YouTube: \"carikan tutorial masak rendang\"\n" +
      "• 🐙 GitHub: \"ada PR baru?\", \"bikin issue: bug di login\", \"baca file X di repo Y\"\n" +
      "• 🧮 Kalkulator & 🔎 web search otomatis\n" +
      (isGoogleConnected()
        ? "• 📅 Google Calendar: \"jadwalin meeting besok jam 2\", \"jadwal aku minggu ini apa aja?\"\n" +
          "• 📄 Google Docs: \"buatin dokumen berisi ...\"\n" +
          "• 📂 Google Drive: \"cari file feedback di gdrive\", \"baca isi file X\"\n" +
          "• 📧 Gmail: \"ada email penting?\", \"kirim email ke X\" (selalu konfirmasi dulu)\n" +
          "• 📊 Sheets: \"catat pengeluaran 50rb makan ke spreadsheet\", \"isi sheet X apa aja?\"\n"
        : "") +
      (isGroup
        ? "• 👥 Grup: \"tag semua\", \"bikin polling ...\", \"ringkasan harian jam 21:00\"\n" +
          "• 🤫 John kadang nimbrung sendiri kalau relevan — \"john diem\" (kalem 1 jam), \"john pasif\"/\"john proaktif\" (atur mode)\n"
        : "") +
      (ctx.isOwner ? "• 🔐 Whitelist (owner): \"tambahin 0812xxx ke whitelist, itu Budi\", \"lihat whitelist\"\n" : "") +
      "\nPerintah cepat: /summary (ringkas 24 jam), /notes, /remind 10m pesan (atau 15:00)."
    );
  }

  const history = getRecentHistory(chatJid, 14);
  const facts = getFacts(senderNumber);
  const notes = getNotesForChats(ctx.relevantChatJids, 12);
  return answerQuestion(history, facts, senderName, notes, buildSkills(ctx));
}

export function createMessageHandler({ waState }) {
  return async function onMessage(sock, m) {
    if (m.key.fromMe) return;

    const chatJid = m.key.remoteJid;
    if (!chatJid || chatJid === "status@broadcast") return;
    const isGroup = chatJid.endsWith("@g.us");
    const senderJid = isGroup ? m.key.participant : chatJid;
    // WhatsApp now often addresses chats by a privacy @lid instead of the real
    // number. Baileys still passes the real number alongside it as senderPn /
    // participantPn when available — prefer that for whitelist matching, and
    // remember the lid->number pair for messages where the real number is
    // missing. An unknown lid resolves to nothing and fails the whitelist
    // check (fail closed) rather than being guessed.
    const senderPn = isGroup ? m.key.participantPn : m.key.senderPn;
    let senderNumber = bareNumber(senderPn || senderJid);
    if (senderJid?.endsWith("@lid")) {
      const lid = bareNumber(senderJid);
      if (senderPn) upsertLidMapping(lid, senderNumber);
      else senderNumber = getNumberForLid(lid) ?? senderNumber;
    }
    const senderName = m.pushName || senderNumber;
    const text = getMessageText(m).trim();
    if (!text) return;

    // Whitelist is the single source of truth for who may talk to the bot —
    // in DMs AND in groups. The owner is auto-added at startup (index.js).
    const whitelisted = isWhitelisted(senderNumber);
    console.log(
      `[handler] chatJid=${chatJid} senderJid=${senderJid} senderNumber=${senderNumber} isGroup=${isGroup} whitelisted=${whitelisted} text=${JSON.stringify(text.slice(0, 60))}`
    );
    // Non-whitelisted DMs: silently ignored, nothing stored. Non-whitelisted
    // group members: their messages are still logged below (the group
    // summary feature needs the whole conversation) but the bot never
    // replies to them and never mines facts/notes from them.
    if (!isGroup && !whitelisted) return;

    if (whitelisted) upsertContact(senderNumber, senderName);

    insertMessage({
      chat_jid: chatJid,
      chat_name: isGroup ? m.key.remoteJid : senderName,
      sender_jid: senderJid,
      sender_name: senderName,
      sender_number: senderNumber,
      is_group: isGroup ? 1 : 0,
      text,
      is_from_me: 0,
      created_at: Date.now(),
    });

    if (whitelisted) {
      for (const link of extractLinks(text)) {
        addNote(chatJid, link, "link");
      }
    }

    // Tier-0 triggers, cheapest first: explicit mention/trigger word, a
    // swipe-reply to one of the bot's own messages, or a follow-up moments
    // after the bot spoke by someone who was in that exchange.
    const triggered =
      isGroup && (isMentioned(m, waState) || isReplyToBot(m, waState) || isRecentExchange(chatJid, senderNumber));
    let shouldReply = whitelisted && (isGroup ? triggered : true);
    let proactive = false;

    if (whitelisted) {
      // Tier 1: not addressed, but maybe worth joining anyway. The join
      // decision piggybacks on the analyze pass that runs per message
      // regardless (notes + facts), so it costs no extra LLM call — just a
      // slightly bigger prompt. Guardrails: per-chat toggle, mute window,
      // and a cooldown between uninvited interjections.
      const settings = isGroup ? getChatSettings(chatJid) : null;
      const canConsiderJoin =
        isGroup &&
        !shouldReply &&
        settings.proactive === 1 &&
        settings.muted_until < Date.now() &&
        Date.now() - settings.last_unsolicited_at > UNSOLICITED_COOLDOWN_MS;

      if (canConsiderJoin) {
        const groupContext = getRecentHistory(chatJid, 9)
          .filter((r) => r.text !== text || r.is_from_me) // current message is passed separately
          .slice(-8)
          .map((r) => `${r.is_from_me ? config.botDisplayName : r.sender_name || r.sender_number}: ${r.text.slice(0, 200)}`)
          .join("\n");
        try {
          const { note, facts, join, joinReason } = await analyzeMessage(text, senderName, { groupContext });
          if (note) addNote(chatJid, note, "note");
          facts.forEach((f) => upsertFact(senderNumber, f.key, f.value));
          if (join) {
            // Record before generating the reply so a burst of messages
            // can't all decide to join within the same cooldown window.
            updateChatSettings(chatJid, { last_unsolicited_at: Date.now() });
            proactive = true;
            shouldReply = true;
            console.log(`[handler] proactive join: ${joinReason || "(no reason given)"}`);
          }
        } catch (err) {
          console.error("[handler] analyzeMessage failed:", err);
        }
      } else {
        // Single combined pass: note-worthiness + durable facts about the
        // sender (facts keyed by phone number so they follow the person
        // across DMs and groups without blending with others).
        analyzeMessage(text, senderName)
          .then(({ note, facts }) => {
            if (note) addNote(chatJid, note, "note");
            facts.forEach((f) => upsertFact(senderNumber, f.key, f.value));
          })
          .catch((err) => console.error("[handler] analyzeMessage failed:", err));
      }
    }

    if (!shouldReply) return;

    const query = isGroup ? stripTrigger(text) : text;
    if (!query) return;

    // In a DM, also pull in notes from any group chats this person is part of —
    // otherwise "jadwal kita" discussed in the group looks invisible when the
    // same person asks about it directly, because notes are stored per-chat.
    const relevantChatJids = isGroup ? [chatJid] : [chatJid, ...getGroupChatsForPerson(senderNumber)];
    // The reply can take 30-60s (LLM + skill chain); if the flaky connection
    // drops and reconnects in that window, the sock captured at message time
    // is dead and every send on it times out. Always resolve the CURRENT
    // socket at send time instead of holding on to this one.
    const live = () => getSocket() ?? sock;
    const ctx = {
      chatJid,
      senderNumber,
      senderName,
      isGroup,
      isOwner: senderNumber === normalizeNumber(config.ownerNumber),
      relevantChatJids,
      get sock() {
        return live();
      },
    };

    // Mark as read + show typing so the sender can tell the bot is working
    // on it instead of staring at an unread, silent chat.
    sock.readMessages([m.key]).catch(() => {});
    const stopTyping = startTyping(live, chatJid);

    try {
      // Longer than the old 35s: a skill chain (e.g. search -> weather) can
      // legitimately take a few LLM rounds plus external API calls.
      let rawReply;
      try {
        rawReply = await withTimeout(routeCommand(query, ctx), 75_000, "routeCommand");
      } catch (firstErr) {
        // Network blips here take down the LLM call and the WA socket
        // together for a minute or two (seen as 408 timedOut in the logs).
        // Waiting out the reconnect and retrying once turns "no reply at
        // all" into "a late reply". Minor caveat: a mutating skill that ran
        // before the failure could run twice — acceptable for how rare
        // full-chain failures are.
        console.warn("[handler] first attempt failed, retrying in 10s:", firstErr.message);
        await new Promise((r) => setTimeout(r, 10_000));
        rawReply = await withTimeout(routeCommand(query, ctx), 75_000, "routeCommand retry");
      }
      if (rawReply) {
        const reply = toWhatsAppFormat(rawReply);
        // Two attempts: if the first send hits a just-died socket, the
        // reconnect (see connection.js) usually completes within seconds —
        // resolve the socket again and retry instead of dropping the reply.
        for (let attempt = 1; ; attempt++) {
          try {
            await withTimeout(live().sendMessage(chatJid, { text: reply }, { quoted: m }), 15_000, "sendMessage");
            break;
          } catch (sendErr) {
            if (attempt >= 2) throw sendErr;
            console.warn("[handler] sendMessage failed, retrying on current socket:", sendErr.message);
            await new Promise((r) => setTimeout(r, 3_000));
          }
        }
        insertMessage({
          chat_jid: chatJid,
          chat_name: isGroup ? m.key.remoteJid : senderName,
          sender_jid: waState.ownJid || "bot",
          sender_name: config.botTriggerName,
          is_group: isGroup ? 1 : 0,
          text: reply,
          is_from_me: 1,
          created_at: Date.now(),
        });
      }
    } catch (err) {
      console.error("[handler] routeCommand failed:", err);
      try {
        await withTimeout(
          live().sendMessage(chatJid, { text: "Maaf, ada error waktu memproses pesan itu." }, { quoted: m }),
          10_000,
          "error-reply sendMessage"
        );
      } catch (sendErr) {
        // Socket is probably mid-reconnect (e.g. dropped connection) — the
        // outer handler in connection.js already retries the connection;
        // nothing more to do here than avoid an unhandled rejection.
        console.error("[handler] failed to send error reply (socket likely down):", sendErr.message);
      }
    } finally {
      stopTyping();
    }
  };
}
