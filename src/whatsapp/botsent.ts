/**
 * IDs of messages the bot itself sent. Both the bot's replies and the owner's
 * manual typing arrive back as `fromMe` events, so this set is how the handler
 * tells them apart: a fromMe message whose ID is NOT here was typed by the owner
 * (= human takeover). IDs are recorded BEFORE the send (see connection.ts) so the
 * echo of our own message can never be seen before we know it is ours.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const sent = new Map<string, number>();

export function rememberBotMessage(id: string) {
  const now = Date.now();
  sent.set(id, now);
  if (sent.size > 500) {
    for (const [k, t] of sent) if (now - t > TTL_MS) sent.delete(k);
  }
}

export function isBotMessage(id?: string | null) {
  return !!id && sent.has(id);
}
