import { config } from "../config.js";
import {
  insertMessage,
  updateMessageText,
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
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { summarizeMessages, answerQuestion, analyzeMessage, extractLinks, describeImage } from "../llm.js";
import { buildSkills } from "../skills/index.js";
import { isGoogleConnected } from "../google.js";
import { getSocket } from "./connection.js";
import { isSomeoneTyping } from "./typing.js";
import {
  getPendingCommand,
  clearPendingCommand,
  isConfirmation,
  isCancellation,
  executeCommand,
} from "../skills/shell.js";
import { toWhatsAppFormat } from "../format.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_CMD_RE = /^\/remind\s+(\d+[smh]|\d{1,2}:\d{2})\s+(.+)$/i;
// Minimum gap between uninvited group interjections — the difference between
// "helpful" and "sok asik".
const UNSOLICITED_COOLDOWN_MS = 10 * 60_000;

// Reply-queue tuning (see the queue section in createMessageHandler).
const GROUP_DEBOUNCE_MS = 5_000;
const DM_DEBOUNCE_MS = 1_500;
const TYPING_WAIT_STEP_MS = 1_500;
const TYPING_WAIT_MAX_MS = 15_000;

// sock.sendMessage() to a group can internally hang fetching group metadata
// (seen on this server's flaky network) without ever resolving OR rejecting —
// a plain try/catch doesn't help there. Promise.race forces it to give up.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Send with one retry against the current (possibly reconnected) socket.
async function sendWithRetry(chatJid, text, quoted) {
  for (let attempt = 1; ; attempt++) {
    try {
      const sock = getSocket();
      await withTimeout(sock.sendMessage(chatJid, { text }, { quoted }), 15_000, "sendMessage");
      return;
    } catch (sendErr) {
      if (attempt >= 2) throw sendErr;
      console.warn("[handler] sendMessage failed, retrying on current socket:", sendErr.message);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
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

// contextInfo (mentions, quoted message) lives inside whichever content
// container the message uses — extendedTextMessage for plain text replies,
// imageMessage for photo captions, etc. Scan them all.
function getContextInfo(m) {
  for (const content of Object.values(m.message ?? {})) {
    if (content && typeof content === "object" && content.contextInfo) return content.contextInfo;
  }
  return null;
}

function isMentioned(m, waState) {
  const mentioned = getContextInfo(m)?.mentionedJid ?? [];
  const ownIds = [waState.ownJid, waState.ownLid].filter(Boolean).map(bareNumber);
  if (mentioned.some((j) => ownIds.includes(bareNumber(j)))) return true;
  return getMessageText(m).toLowerCase().includes(config.botTriggerName);
}

// A swipe-reply to one of the bot's own messages is always addressed to the
// bot, trigger word or not. The quoted participant may be the bot's phone
// jid or its privacy lid depending on the chat — match either.
function isReplyToBot(m, waState) {
  const participant = getContextInfo(m)?.participant;
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

// Proactive-mode controls, regex-based so they always work even when the LLM
// is having a bad day. Handled directly in onMessage (bypassing the reply
// queue) so "John diem!" applies instantly and can't be displaced by a
// newer message in a burst. Returns the confirmation text, or null.
function groupModeCommand(lower, chatJid) {
  // Short imperative only ("diem dulu", "stop john", "diem sampe besok") —
  // a longer sentence containing the word ("kok diem aja sih?") is
  // conversation, not a command.
  if (
    lower.length <= 30 &&
    /(^|\s)(diem|diam|kalem|stop)\b/.test(lower) &&
    !/\b(kok|kenapa|knp|jangan|nggak|gak|ga)\b/.test(lower)
  ) {
    let ms = 60 * 60_000;
    let label = "sejam";
    const dur = lower.match(/(\d+)\s*(jam|menit)/);
    if (dur) {
      ms = Number(dur[1]) * (dur[2] === "jam" ? 3_600_000 : 60_000);
      label = `${dur[1]} ${dur[2]}`;
    } else if (/\b(sampe|sampai)\s*(besok|pagi)\b/.test(lower)) {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      t.setHours(7, 0, 0, 0);
      ms = t.getTime() - Date.now();
      label = "sampai besok pagi";
    }
    updateChatSettings(chatJid, { muted_until: Date.now() + ms });
    return `Siap, John kalem dulu ${label} 🤐 Panggil nama John atau reply pesan John kalau butuh.`;
  }
  if (/\bpasif\b/.test(lower)) {
    updateChatSettings(chatJid, { proactive: 0 });
    return "Oke, mode pasif: John cuma jawab kalau dipanggil atau di-reply di grup ini. 🫡";
  }
  if (/\b(proaktif|bangun|aktif lagi)\b/.test(lower)) {
    updateChatSettings(chatJid, { proactive: 1, muted_until: 0 });
    return "John aktif lagi! 😎 Siap nimbrung kalau ada yang bisa dibantu.";
  }
  return null;
}

async function routeCommand(query, ctx) {
  const { chatJid, senderName, senderNumber, isGroup } = ctx;
  const lower = query.toLowerCase();

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
  // Per-chat reply queue state, and which groups we've presence-subscribed
  // (needed for WhatsApp to send us their typing updates).
  const replyQueues = new Map();
  const presenceSubscribed = new Set();

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

    // Photo attached directly, or a swipe-reply to an earlier photo ("john
    // ini gambar apa?"). For quoted photos the full media descriptor
    // (mediaKey etc.) rides along in quotedMessage, so it stays downloadable.
    const ctxInfo = getContextInfo(m);
    let imageInfo = null;
    if (m.message?.imageMessage) {
      imageInfo = { media: m, meta: m.message.imageMessage, quoted: false };
    } else if (ctxInfo?.quotedMessage?.imageMessage) {
      imageInfo = {
        media: {
          key: { remoteJid: chatJid, id: ctxInfo.stanzaId, participant: ctxInfo.participant },
          message: ctxInfo.quotedMessage,
        },
        meta: ctxInfo.quotedMessage.imageMessage,
        quoted: true,
      };
    }

    if (!text && !imageInfo) return;

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

    const messageId = insertMessage({
      chat_jid: chatJid,
      chat_name: isGroup ? m.key.remoteJid : senderName,
      sender_jid: senderJid,
      sender_name: senderName,
      sender_number: senderNumber,
      is_group: isGroup ? 1 : 0,
      text: imageInfo && !imageInfo.quoted ? `[foto]${text ? ` ${text}` : ""}` : text,
      is_from_me: 0,
      created_at: Date.now(),
    });

    if (whitelisted) {
      for (const link of extractLinks(text)) {
        addNote(chatJid, link, "link");
      }
    }

    // Explicit triggers (mention, trigger word, swipe-reply to the bot)
    // always work — that's what the mute confirmation promises. Ambient
    // triggers (continuation window, proactive join) are exactly what
    // "john diem" / "john pasif" exist to switch off, so they're gated:
    // previously the mute confirmation itself restarted the continuation
    // window and John kept "peeking out from under the table" forever.
    const settings = isGroup ? getChatSettings(chatJid) : null;
    const explicit = isGroup && (isMentioned(m, waState) || isReplyToBot(m, waState));
    const ambientAllowed = isGroup && settings.proactive === 1 && settings.muted_until < Date.now();
    const triggered = explicit || (ambientAllowed && isRecentExchange(chatJid, senderNumber));
    let shouldReply = whitelisted && (isGroup ? triggered : true);
    let proactive = false;

    if (whitelisted) {
      // Tier 1: not addressed, but maybe worth joining anyway. The join
      // decision piggybacks on the analyze pass that runs per message
      // regardless (notes + facts), so it costs no extra LLM call — just a
      // slightly bigger prompt. Guardrails: per-chat toggle, mute window,
      // and a cooldown between uninvited interjections.
      const canConsiderJoin =
        isGroup &&
        !shouldReply &&
        ambientAllowed &&
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

    // Owner shell confirmation (DM only): if a command is staged and the
    // owner's message is a deterministic yes, run it now — the model is never
    // in this decision, so it can't self-confirm a hallucinated command.
    const isOwnerDM = !isGroup && senderNumber === normalizeNumber(config.ownerNumber);
    if (isOwnerDM) {
      const staged = getPendingCommand(senderNumber);
      if (staged) {
        if (isConfirmation(text)) {
          clearPendingCommand(senderNumber);
          sock.readMessages([m.key]).catch(() => {});
          console.log(`[shell] executing (owner-confirmed): ${staged}`);
          const result = await executeCommand(staged);
          const header = result.ok ? "✅ Selesai" : `⚠️ Gagal (${result.code}${result.timedOut ? ", timeout" : ""})`;
          const reply = `${header}:\n\`\`\`\n${result.output}\n\`\`\``;
          await sendWithRetry(chatJid, reply, m).catch((err) =>
            console.error("[shell] failed to send output:", err.message)
          );
          insertMessage({
            chat_jid: chatJid, chat_name: senderName, sender_jid: waState.ownJid || "bot",
            sender_name: config.botTriggerName, is_group: 0, text: reply, is_from_me: 1, created_at: Date.now(),
          });
          return;
        }
        if (isCancellation(text)) {
          clearPendingCommand(senderNumber);
          // fall through to a normal reply (John will acknowledge the cancel)
        }
        // anything else: leave it staged (owner might be clarifying) and
        // answer normally.
      }
    }

    const query = isGroup ? stripTrigger(text) : text;
    if (!query && !(imageInfo && config.llmVisionModel)) return;

    // Mode commands apply immediately, skipping the queue — a queued mute
    // could be displaced by the next message in a burst and never land.
    if (isGroup && explicit) {
      const confirmation = groupModeCommand(query.toLowerCase(), chatJid);
      if (confirmation) {
        const q = replyQueues.get(chatJid);
        if (q) q.job = null; // drop any queued ambient reply — we were just told to hush
        getSocket()
          ?.sendMessage(chatJid, { text: confirmation }, { quoted: m })
          .catch((err) => console.error("[handler] mode confirmation send failed:", err.message));
        insertMessage({
          chat_jid: chatJid,
          chat_name: m.key.remoteJid,
          sender_jid: waState.ownJid || "bot",
          sender_name: config.botTriggerName,
          is_group: 1,
          text: confirmation,
          is_from_me: 1,
          created_at: Date.now(),
        });
        return;
      }
    }

    // Subscribe once per group so WhatsApp starts sending us typing
    // (presence) updates for it — best-effort, used by the reply queue.
    if (isGroup && !presenceSubscribed.has(chatJid)) {
      presenceSubscribed.add(chatJid);
      Promise.resolve(sock.presenceSubscribe?.(chatJid)).catch(() => {});
    }

    // Mark as read right away; the actual reply goes through the per-chat
    // queue below (debounced, typing-aware, one generation at a time).
    sock.readMessages([m.key]).catch(() => {});
    scheduleReply({ sock, m, chatJid, senderName, senderNumber, isGroup, explicit, query, text, imageInfo, messageId });
  };

  // ---- Per-chat reply queue ----------------------------------------------
  // People text in bursts ("lanjut kerja ya" / "hehe makasii" / "byee" within
  // seconds) and John used to answer every single one, sometimes with two
  // generations racing in parallel. Instead: debounce a few seconds so the
  // burst settles (newest message wins — history carries the rest), hold on
  // while someone is visibly typing, and never run more than one reply
  // generation per chat at a time. (Function declarations hoist above the
  // return, so onMessage can call these.)
  function scheduleReply(job) {
    let q = replyQueues.get(job.chatJid);
    if (!q) replyQueues.set(job.chatJid, (q = { job: null, timer: null, running: false }));
    q.job = job;
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(
      () => {
        q.timer = null;
        runReplyQueue(job.chatJid).catch((err) => console.error("[handler] reply queue error:", err));
      },
      job.isGroup ? GROUP_DEBOUNCE_MS : DM_DEBOUNCE_MS
    );
  }

  async function runReplyQueue(chatJid) {
    const q = replyQueues.get(chatJid);
    if (!q || q.running) return;
    q.running = true;
    try {
      while (q.job) {
        // Let an active typer finish — their message may change the answer
        // (and would otherwise trigger yet another reply right after ours).
        if (q.job.isGroup) {
          const start = Date.now();
          while (isSomeoneTyping(chatJid) && Date.now() - start < TYPING_WAIT_MAX_MS) {
            await new Promise((r) => setTimeout(r, TYPING_WAIT_STEP_MS));
          }
        }
        const job = q.job;
        q.job = null;
        await generateAndSendReply(job);
      }
    } finally {
      q.running = false;
    }
  }

  async function generateAndSendReply(job) {
    const { sock, m, chatJid, senderName, senderNumber, isGroup, explicit, text, imageInfo, messageId } = job;
    let query = job.query;

    // Conditions may have changed during the debounce ("john diem" arriving
    // right behind the message we were about to answer) — re-check before
    // speaking unless the message addressed John explicitly.
    if (isGroup && !explicit) {
      const settings = getChatSettings(chatJid);
      if (settings.proactive !== 1 || settings.muted_until > Date.now()) return;
    }

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
      imageBuffer: null, // raw photo bytes, shared by vision + sticker skills
      get sock() {
        return live();
      },
    };

    const stopTyping = startTyping(live, chatJid);

    try {
      // Download the photo once — the sticker skill needs the raw bytes even
      // when vision is off, and vision writes its description into this
      // message's history row so routeCommand's history fetch (and any later
      // "foto yang tadi" question) picks it up. Failures degrade to
      // answering from the caption alone.
      if (imageInfo) {
        try {
          ctx.imageBuffer = await downloadMediaMessage(imageInfo.media, "buffer", {});
        } catch (err) {
          console.error("[handler] image download failed:", err.message);
        }
        if (ctx.imageBuffer && config.llmVisionModel) {
          try {
            const mime = imageInfo.meta.mimetype || "image/jpeg";
            const desc = await describeImage(`data:${mime};base64,${ctx.imageBuffer.toString("base64")}`, query);
            if (desc) {
              const label = imageInfo.quoted ? "membalas foto" : "foto";
              updateMessageText(messageId, `[${label}: ${desc}]${text ? ` ${text}` : ""}`);
              if (!query) query = "[foto]";
            }
          } catch (err) {
            console.error("[handler] image describe failed:", err.message);
          }
        }
        if (!query) return; // no caption and no description — nothing to answer
      }
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
  }
}
