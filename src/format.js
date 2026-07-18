/**
 * LLMs default to standard markdown (**bold**, ### headers), but
 * WhatsApp only renders single-asterisk *bold*, _italic_, ~strikethrough~ —
 * anything else shows up as literal asterisks/hashes in the chat. Convert
 * before sending, as a safety net on top of prompting the model directly.
 */
// De-bold storms: the model sometimes bolds *nearly* *every* *word* (a
// self-reinforcing habit — it imitates its own earlier messages in the chat
// history). Prompt rules alone don't stop it, so enforce deterministically:
// when bolding is that dense it carries no emphasis anyway, strip it all.
function stripBoldStorm(text) {
  const bolds = text.match(/\*[^*\n]+\*/g) ?? [];
  if (bolds.length < 6) return text;
  const totalWords = text.split(/\s+/).filter(Boolean).length;
  const boldWords = bolds.join(" ").split(/\s+/).filter(Boolean).length;
  if (boldWords / totalWords < 0.4) return text;
  return text.replace(/\*([^*\n]+)\*/g, "$1");
}

export function toWhatsAppFormat(text) {
  if (!text) return text;
  return stripBoldStorm(
    text
      .replace(/\*\*\*(.+?)\*\*\*/g, "*$1*") // bold+italic -> bold
      .replace(/\*\*(.+?)\*\*/g, "*$1*") // markdown bold -> WA bold
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*") // markdown headers -> WA bold
  );
}
