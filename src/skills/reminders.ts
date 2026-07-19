import { addReminder, getPendingReminders, cancelReminder } from "../db.js";

const localTime = (ts) => new Date(ts).toLocaleString("id-ID");

function resolveFireAt({ delay_seconds, at_time }) {
  if (Number(delay_seconds) > 0) return Date.now() + Math.round(Number(delay_seconds)) * 1000;

  const m = String(at_time ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const target = new Date();
    target.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  return null;
}

export function skills(ctx) {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "set_reminder",
          description:
            "Set a reminder that will be sent to this chat. Use whenever the user asks to be reminded of " +
            "something ('ingetin aku...', 'remind me...'). Supports one-off and daily/weekly recurring reminders.",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "What to remind about" },
              delay_seconds: { type: "number", description: "Seconds from now until the reminder fires (for relative times like 'in 10 minutes')" },
              at_time: { type: "string", description: "Local time HH:MM for absolute times like 'jam 15:00'. If already past today, fires tomorrow." },
              repeat: { type: "string", enum: ["none", "daily", "weekly"], description: "Repeat schedule; default none" },
            },
            required: ["message"],
          },
        },
      },
      execute: ({ message, delay_seconds, at_time, repeat }) => {
        const fireAt = resolveFireAt({ delay_seconds, at_time });
        if (!fireAt) return { error: "provide delay_seconds or at_time (HH:MM)" };
        const rep = repeat === "daily" || repeat === "weekly" ? repeat : null;
        addReminder(ctx.chatJid, message, fireAt, rep);
        return { ok: true, fires_at: localTime(fireAt), repeat: rep ?? "none" };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_reminders",
          description: "List pending reminders for this chat, including their ids (needed to cancel one).",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: () => ({
        reminders: getPendingReminders(ctx.chatJid).map((r) => ({
          id: r.id,
          message: r.message,
          fires_at: localTime(r.fire_at),
          repeat: r.repeat ?? "none",
        })),
      }),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "cancel_reminder",
          description: "Cancel a pending reminder by id (use list_reminders first to find the id).",
          parameters: {
            type: "object",
            properties: { id: { type: "number", description: "Reminder id" } },
            required: ["id"],
          },
        },
      },
      execute: ({ id }) => (cancelReminder(Number(id), ctx.chatJid) ? { ok: true } : { error: "no pending reminder with that id in this chat" }),
    },
  ];
}
