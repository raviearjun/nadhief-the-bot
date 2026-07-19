import { getRecentMessages } from "../db.js";
import { summarizeMessages } from "../llm.js";

const HOUR_MS = 60 * 60 * 1000;

export function skills(ctx) {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "summarize_chat",
          description:
            "Summarize this chat's recent messages (key points, links, action items). " +
            "Use when asked to recap or catch up on the conversation ('ringkas', 'apa aja yang dibahas').",
          parameters: {
            type: "object",
            properties: {
              hours: { type: "number", description: "How many hours back to summarize (default 24, max 168)" },
            },
          },
        },
      },
      execute: async ({ hours }) => {
        const h = Math.min(Math.max(Number(hours) || 24, 1), 168);
        const messages = getRecentMessages(ctx.chatJid, Date.now() - h * HOUR_MS);
        const summary = await summarizeMessages(messages, { label: ctx.senderName });
        return { summary };
      },
    },
  ];
}
