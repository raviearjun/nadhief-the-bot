/**
 * LLMs default to standard markdown (**bold**, ### headers), but
 * WhatsApp only renders single-asterisk *bold*, _italic_, ~strikethrough~ —
 * anything else shows up as literal asterisks/hashes in the chat. Convert
 * before sending, as a safety net on top of prompting the model directly.
 */
export function toWhatsAppFormat(text) {
  if (!text) return text;
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, "*$1*") // bold+italic -> bold
    .replace(/\*\*(.+?)\*\*/g, "*$1*") // markdown bold -> WA bold
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*"); // markdown headers -> WA bold
}
