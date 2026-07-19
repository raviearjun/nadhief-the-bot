/**
 * Tracks who is currently typing in which chat, fed by Baileys
 * presence.update events (connection.js wires the listener; the handler must
 * presenceSubscribe() each chat before WhatsApp will send its updates).
 * Used to hold John's reply while a human is mid-sentence.
 */
const COMPOSING_TTL_MS = 5_000;
const composing = new Map(); // chatJid -> Map(participantJid -> lastComposingTs)

export function notePresenceUpdate(update) {
  const { id, presences } = update ?? {};
  if (!id || !presences) return;
  let chat = composing.get(id);
  if (!chat) composing.set(id, (chat = new Map()));
  for (const [jid, p] of Object.entries(presences)) {
    const state = (p as any)?.lastKnownPresence;
    if (state === "composing" || state === "recording") chat.set(jid, Date.now());
    else chat.delete(jid);
  }
}

export function isSomeoneTyping(chatJid) {
  const chat = composing.get(chatJid);
  if (!chat) return false;
  const now = Date.now();
  for (const [jid, ts] of chat) {
    if (now - ts <= COMPOSING_TTL_MS) return true;
    chat.delete(jid);
  }
  return false;
}
