import { setGroupSummaryTime, disableGroupSummary } from "../db.js";

// groupMetadata can hang on a flaky connection (same failure mode as
// sendMessage — see handler.js); force it to give up instead.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export function skills(ctx) {
  if (!ctx.isGroup || !ctx.sock) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "tag_all_members",
          description:
            "Mention (@tag) every member of this group with a message, so everyone gets notified. " +
            "Use when asked to announce something to everyone ('tag semua', '@all', 'panggil semua orang').",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "The announcement text to send along with the mentions" },
            },
            required: ["message"],
          },
        },
      },
      execute: async ({ message }) => {
        const meta = await withTimeout(ctx.sock.groupMetadata(ctx.chatJid), 10_000, "groupMetadata");
        const jids = meta.participants.map((p) => p.id);
        const mentionLine = jids.map((j) => `@${j.split("@")[0]}`).join(" ");
        await withTimeout(
          ctx.sock.sendMessage(ctx.chatJid, { text: `${message}\n\n${mentionLine}`, mentions: jids }),
          15_000,
          "sendMessage tag_all"
        );
        return { ok: true, tagged: jids.length, note: "announcement already sent — just confirm briefly, don't repeat it" };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "create_poll",
          description:
            "Create a native WhatsApp poll in this group. Use when asked to make a poll/vote " +
            "('bikin polling', 'voting yuk'). 2-12 options.",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string", description: "The poll question" },
              options: { type: "array", items: { type: "string" }, description: "2-12 answer options" },
              multiple_answers: { type: "boolean", description: "Allow selecting more than one option (default false)" },
            },
            required: ["question", "options"],
          },
        },
      },
      execute: async ({ question, options, multiple_answers }) => {
        const values = (options ?? []).map((o) => String(o).trim()).filter(Boolean);
        if (values.length < 2 || values.length > 12) return { error: "need between 2 and 12 options" };
        await withTimeout(
          ctx.sock.sendMessage(ctx.chatJid, {
            poll: { name: question, values, selectableCount: multiple_answers ? values.length : 1 },
          }),
          15_000,
          "sendMessage poll"
        );
        return { ok: true, note: "poll already sent — just confirm briefly" };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "set_daily_group_summary",
          description:
            "Enable or disable an automatic daily summary of this group, sent to the group at a given time. " +
            "Use when asked for a recurring recap ('ringkasan tiap malam jam 9').",
          parameters: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              time: { type: "string", description: "Local time HH:MM to send the summary (required when enabling)" },
            },
            required: ["enabled"],
          },
        },
      },
      execute: ({ enabled, time }) => {
        if (!enabled) {
          disableGroupSummary(ctx.chatJid);
          return { ok: true, status: "disabled" };
        }
        const m = String(time ?? "").match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return { error: "time must be HH:MM" };
        const hour = Number(m[1]);
        const minute = Number(m[2]);
        if (hour > 23 || minute > 59) return { error: "invalid time" };
        setGroupSummaryTime(ctx.chatJid, hour, minute);
        return { ok: true, status: `daily summary at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
      },
    },
  ];
}
