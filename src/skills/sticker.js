import sharp from "sharp";

/**
 * Turns the photo in the current message (attached or swipe-replied) into a
 * WhatsApp sticker: 512x512 webp, transparent padding. The handler downloads
 * the image once (shared with the vision skill) and exposes it as
 * ctx.imageBuffer; the tool sends the sticker itself, so the model only needs
 * to confirm briefly.
 */
export function skills(ctx) {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "make_sticker",
          description:
            "Convert the photo in the current message (sent directly or quoted via reply) into a WhatsApp " +
            "sticker and send it to this chat. Use for 'jadiin sticker', 'stickerin ini', 'bikin sticker dari " +
            "foto ini'. The sticker is sent automatically — just confirm briefly afterwards. Requires a photo " +
            "in the message; if there is none, tell the user to send or reply to one.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => {
        if (!ctx.imageBuffer) {
          return { error: "tidak ada foto di pesan ini — minta user kirim foto (atau reply foto) sambil minta sticker" };
        }
        const webp = await sharp(ctx.imageBuffer)
          .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 80 })
          .toBuffer();
        await ctx.sock.sendMessage(ctx.chatJid, { sticker: webp });
        return { ok: true, sent: "sticker terkirim" };
      },
    },
  ];
}
