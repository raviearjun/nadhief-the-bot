import PptxGenJSImport from "pptxgenjs";
import PDFDocument from "pdfkit";

// Under tsx/ESM interop the default import is a namespace wrapper; the actual
// constructor lives on `.default`.
const PptxGenJS: any = (PptxGenJSImport as any)?.default || PptxGenJSImport;

/**
 * Generate documents for the user and send them straight into the chat as a
 * WhatsApp file attachment:
 *   - create_slides -> a presentation deck (.pptx, or .pdf)
 *   - create_pdf    -> a plain PDF document (report/letter style)
 * The model composes the content (via the tool arguments); these just render
 * and send. Like make_sticker, the file is sent by the tool itself.
 */

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function safeName(title: string, ext: string): string {
  const base = (title || "dokumen").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "_").slice(0, 60) || "dokumen";
  return `${base}.${ext}`;
}

function pdfToBuffer(build: (doc: any) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      build(doc);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function slidesToPptx(title: string, slides: any[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 16:9

  const title_ = pptx.addSlide();
  title_.background = { color: "1E293B" };
  title_.addText(title || "Presentasi", {
    x: 0.5, y: 2.3, w: "90%", h: 1.6, align: "center",
    fontSize: 40, bold: true, color: "FFFFFF",
  });

  for (const sl of slides) {
    const s = pptx.addSlide();
    s.addText(String(sl?.heading || ""), { x: 0.5, y: 0.4, w: "92%", h: 0.9, fontSize: 28, bold: true, color: "1E293B" });
    const bullets = (Array.isArray(sl?.bullets) ? sl.bullets : [])
      .filter(Boolean)
      .map((b: any) => ({ text: String(b), options: { bullet: true, fontSize: 18, color: "334155", breakLine: true, paraSpaceAfter: 8 } }));
    if (bullets.length) s.addText(bullets as any, { x: 0.7, y: 1.5, w: "88%", h: 4.2, valign: "top" });
  }
  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}

function slidesToPdf(title: string, slides: any[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      // title page
      doc.rect(0, 0, doc.page.width, doc.page.height).fill("#1E293B");
      doc.fill("#FFFFFF").fontSize(34).text(title || "Presentasi", 56, doc.page.height / 2 - 40, {
        width: doc.page.width - 112, align: "center",
      });
      for (const sl of slides) {
        doc.addPage();
        doc.fill("#1E293B").fontSize(26).text(String(sl?.heading || ""), { width: doc.page.width - 112 });
        doc.moveDown(0.8);
        doc.fill("#334155").fontSize(16);
        for (const b of Array.isArray(sl?.bullets) ? sl.bullets : []) {
          if (b) doc.text(`•  ${String(b)}`, { width: doc.page.width - 112 }).moveDown(0.4);
        }
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export function skills(ctx) {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "create_slides",
          description:
            "Buat file presentasi (slide deck) lalu KIRIM otomatis ke chat sebagai file. Pakai untuk permintaan " +
            "seperti 'bikin slide/presentasi tentang X', 'buatin PPT'. KAMU yang menyusun isi tiap slide (judul + " +
            "poin ringkas) berdasarkan permintaan user — jangan minta user menuliskan tiap slide. File terkirim " +
            "otomatis; cukup konfirmasi singkat setelahnya.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Judul presentasi" },
              format: { type: "string", enum: ["pptx", "pdf"], description: "Format output: pptx (PowerPoint, bisa diedit) atau pdf. Default pptx." },
              slides: {
                type: "array",
                description: "Slide-slide isi (di luar slide judul). Ideal 4-10 slide.",
                items: {
                  type: "object",
                  properties: {
                    heading: { type: "string", description: "Judul slide" },
                    bullets: { type: "array", items: { type: "string" }, description: "Poin-poin isi slide, ringkas (3-6 poin)" },
                  },
                  required: ["heading"],
                },
              },
            },
            required: ["title", "slides"],
          },
        },
      },
      execute: async ({ title, slides, format }) => {
        if (!Array.isArray(slides) || slides.length === 0) return { error: "slides kosong — susun minimal 1 slide isi" };
        const deck = slides.slice(0, 30);
        try {
          const pdf = format === "pdf";
          const buffer = pdf ? await slidesToPdf(title, deck) : await slidesToPptx(title, deck);
          const fileName = safeName(title, pdf ? "pdf" : "pptx");
          await ctx.sock.sendMessage(ctx.chatJid, {
            document: buffer,
            fileName,
            mimetype: pdf ? "application/pdf" : PPTX_MIME,
          });
          return { ok: true, sent: `${fileName} (${deck.length + 1} slide) terkirim` };
        } catch (e: any) {
          return { error: `gagal membuat slide: ${e.message}` };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "create_pdf",
          description:
            "Buat dokumen PDF gaya laporan/surat (BUKAN slide) lalu KIRIM otomatis ke chat sebagai file. Pakai untuk " +
            "'bikin PDF berisi X', 'buatin dokumen/laporan PDF'. KAMU susun isinya (judul + bagian berisi paragraf). " +
            "Untuk presentasi/slide gunakan create_slides. File terkirim otomatis; konfirmasi singkat setelahnya.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "Judul dokumen" },
              sections: {
                type: "array",
                description: "Bagian-bagian dokumen, berurutan.",
                items: {
                  type: "object",
                  properties: {
                    heading: { type: "string", description: "Judul bagian (opsional)" },
                    body: { type: "string", description: "Isi paragraf bagian ini" },
                  },
                  required: ["body"],
                },
              },
            },
            required: ["title", "sections"],
          },
        },
      },
      execute: async ({ title, sections }) => {
        if (!Array.isArray(sections) || sections.length === 0) return { error: "sections kosong — susun minimal 1 bagian" };
        try {
          const buffer = await pdfToBuffer((doc) => {
            doc.fillColor("#0F172A").fontSize(24).text(title || "Dokumen", { align: "left" });
            doc.moveDown(1);
            for (const sec of sections.slice(0, 50)) {
              if (sec?.heading) doc.fillColor("#1E293B").fontSize(15).text(String(sec.heading), { underline: false }).moveDown(0.3);
              if (sec?.body) doc.fillColor("#334155").fontSize(11.5).text(String(sec.body), { align: "left", lineGap: 2 });
              doc.moveDown(0.9);
            }
          });
          const fileName = safeName(title, "pdf");
          await ctx.sock.sendMessage(ctx.chatJid, { document: buffer, fileName, mimetype: "application/pdf" });
          return { ok: true, sent: `${fileName} terkirim` };
        } catch (e: any) {
          return { error: `gagal membuat PDF: ${e.message}` };
        }
      },
    },
  ];
}
