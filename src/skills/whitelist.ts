import { addToWhitelist, removeFromWhitelist, listWhitelist, normalizeNumber } from "../db.js";

// Owner-only: the whitelist decides who can talk to the bot at all, so only
// the owner's own messages ever expose these tools.
export function skills(ctx) {
  if (!ctx.isOwner) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "manage_whitelist",
          description:
            "Manage which phone numbers are allowed to talk to the bot (DM and group mentions). " +
            "Actions: add (number + optional label/name), remove (number), list. " +
            "Numbers may be in local (08xx) or international (628xx) format.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "remove", "list"] },
              number: { type: "string", description: "Phone number (for add/remove)" },
              label: { type: "string", description: "Person's name/label (for add)" },
            },
            required: ["action"],
          },
        },
      },
      execute: ({ action, number, label }) => {
        switch (action) {
          case "add": {
            const n = normalizeNumber(number);
            if (n.length < 8) return { error: "invalid number" };
            addToWhitelist(n, label || "");
            return { ok: true, number: n, label: label || "" };
          }
          case "remove": {
            const n = normalizeNumber(number);
            if (n === normalizeNumber(ctx.senderNumber)) return { error: "tidak bisa menghapus nomor owner sendiri" };
            removeFromWhitelist(n);
            return { ok: true, removed: n };
          }
          case "list":
            return { whitelist: listWhitelist().map((w) => ({ number: w.number, label: w.label })) };
          default:
            return { error: "unknown action" };
        }
      },
    },
  ];
}
