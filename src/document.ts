import XLSX from "xlsx";
import mammoth from "mammoth";
import JSZip from "jszip";
import { PDFParse } from "pdf-parse";

// Reads text out of documents users send over WhatsApp (PDF, Word, Excel,
// PowerPoint, CSV/plain text) so the bot can answer/summarise their contents.
// Each format has a dedicated, self-contained pure-JS extractor — no external
// services or system binaries.

const MAX_CHARS = 8000; // cap fed to the LLM — keeps prompts (and cost) sane

export function isReadableDocument(mimetype = "", fileName = ""): boolean {
  return (
    /\.(pdf|docx|xlsx|xls|pptx|csv|txt|md|tsv)$/i.test(fileName) ||
    /(pdf|wordprocessingml|msword|spreadsheetml|ms-?excel|presentationml|ms-?powerpoint|csv|text\/plain)/i.test(mimetype)
  );
}

function guessExt(fileName: string, mimetype: string): string {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (m) return m[1];
  if (/pdf/.test(mimetype)) return "pdf";
  if (/wordprocessingml|msword/.test(mimetype)) return "docx";
  if (/spreadsheetml|ms-?excel/.test(mimetype)) return "xlsx";
  if (/presentationml|ms-?powerpoint/.test(mimetype)) return "pptx";
  if (/csv/.test(mimetype)) return "csv";
  if (/text\/plain/.test(mimetype)) return "txt";
  return "";
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// PPTX/DOCX are zip+XML; pull the visible text runs out of the relevant parts.
async function extractPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
  const parts: string[] = [];
  for (const n of slides) {
    const xml = await zip.file(n)!.async("string");
    const texts = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((mm) => decodeXml(mm[1]));
    const joined = texts.join(" ").trim();
    if (joined) parts.push(joined);
  }
  return parts.join("\n");
}

function extractXlsx(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
    if (csv) parts.push(`# ${name}\n${csv}`);
  }
  return parts.join("\n\n");
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  try {
    const res = await parser.getText();
    // pdf-parse inserts "-- N of M --" page separators. Strip them so an
    // image-only / scanned PDF (no text layer) collapses to empty instead of
    // looking like it had content — that lets the caller give a clear
    // "this looks like a scan, I can't read it" answer.
    return (res.text || "").replace(/^-- \d+ of \d+ --$/gm, "").trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}

export async function extractDocumentText(buffer: Buffer, fileName = "", mimetype = ""): Promise<string> {
  const ext = guessExt(fileName, mimetype);
  let text = "";
  switch (ext) {
    case "pdf":
      text = await extractPdf(buffer);
      break;
    case "docx":
      text = (await mammoth.extractRawText({ buffer })).value || "";
      break;
    case "xlsx":
    case "xls":
      text = extractXlsx(buffer);
      break;
    case "pptx":
      text = await extractPptx(buffer);
      break;
    case "csv":
    case "tsv":
    case "txt":
    case "md":
      text = buffer.toString("utf8");
      break;
    default:
      throw new Error(`unsupported document type: ${ext || mimetype || "unknown"}`);
  }
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function clipForPrompt(text: string, max = MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
