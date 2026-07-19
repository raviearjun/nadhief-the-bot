import cron from "node-cron";
import { config } from "./config.js";
import {
  getAllChatsSince,
  getRecentMessages,
  saveSummary,
  getDueReminders,
  markReminderSent,
  rescheduleReminder,
  getGroupsWithSummaryAt,
} from "./db.js";
import { summarizeMessages } from "./llm.js";
import { toWhatsAppFormat } from "./format.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function startDailyReminder(getSocket) {
  const cronExpr = `${config.reminderMinute} ${config.reminderHour} * * *`;

  cron.schedule(cronExpr, async () => {
    const sock = getSocket();
    if (!sock) {
      console.warn("[scheduler] skipped: WhatsApp not connected");
      return;
    }

    const since = Date.now() - DAY_MS;
    const chats = getAllChatsSince(since);
    if (chats.length === 0) return;

    const parts = [];
    for (const chat of chats) {
      const messages = getRecentMessages(chat.chat_jid, since);
      if (messages.length === 0) continue;
      const summary = toWhatsAppFormat(await summarizeMessages(messages, { label: chat.chat_name || chat.chat_jid }));
      parts.push(`*${chat.chat_name || chat.chat_jid}*\n${summary}`);
    }

    if (parts.length === 0) return;

    const digest = `📋 Ringkasan pagi ini:\n\n${parts.join("\n\n")}`;
    saveSummary("daily-digest", digest);

    const ownerJid = `${config.ownerNumber}@s.whatsapp.net`;
    await sock.sendMessage(ownerJid, { text: digest });
    console.log("[scheduler] daily reminder sent");
  });

  console.log(`[scheduler] daily reminder scheduled at ${config.reminderHour}:${String(config.reminderMinute).padStart(2, "0")}`);
}

const REMINDER_CHECK_INTERVAL_MS = 15_000;

export function startReminderChecker(getSocket) {
  setInterval(async () => {
    const sock = getSocket();
    if (!sock) return;

    const due = getDueReminders(Date.now());
    for (const r of due) {
      try {
        await sock.sendMessage(r.chat_jid, { text: `⏰ Reminder: ${r.message}` });
      } catch (err) {
        console.error("[scheduler] failed to send reminder:", err);
      } finally {
        const period = r.repeat === "daily" ? DAY_MS : r.repeat === "weekly" ? 7 * DAY_MS : 0;
        if (period) {
          // Catch up past the current time in case the bot was down across
          // multiple periods — otherwise it would fire repeatedly on restart.
          let next = r.fire_at + period;
          while (next <= Date.now()) next += period;
          rescheduleReminder(r.id, next);
        } else {
          markReminderSent(r.id);
        }
      }
    }
  }, REMINDER_CHECK_INTERVAL_MS);

  console.log("[scheduler] custom reminder checker running every 15s");
}

// Per-group opt-in daily summary (set via the set_daily_group_summary skill):
// every minute, send a 24h recap to groups whose configured time matches now.
export function startGroupSummaries(getSocket) {
  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const groups = getGroupsWithSummaryAt(now.getHours(), now.getMinutes());
    if (groups.length === 0) return;

    const sock = getSocket();
    if (!sock) {
      console.warn("[scheduler] group summary skipped: WhatsApp not connected");
      return;
    }

    for (const chatJid of groups) {
      try {
        const messages = getRecentMessages(chatJid, Date.now() - DAY_MS);
        if (messages.length === 0) continue;
        const summary = toWhatsAppFormat(await summarizeMessages(messages, { label: "grup ini" }));
        await sock.sendMessage(chatJid, { text: `📋 Ringkasan harian grup:\n\n${summary}` });
        saveSummary(chatJid, summary);
      } catch (err) {
        console.error(`[scheduler] group summary failed for ${chatJid}:`, err);
      }
    }
  });

  console.log("[scheduler] per-group daily summaries enabled");
}
