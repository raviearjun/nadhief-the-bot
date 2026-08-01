import { config } from "./config.js";
import { logLlmUsage } from "./db.js";

const LLM_URL = `${config.llmBaseUrl}/chat/completions`;
// Without this, a stalled connection (this server's network has been flaky —
// see connection.js) leaves fetch() hanging forever: no error, no reply, the
// user just never hears back. Fail fast instead so callers can catch it.
// Reasoning models (gpt-oss-120b etc.) think before answering, so they get
// more headroom than a flash model would need.
const REQUEST_TIMEOUT_MS = 45_000;

// Idle (not total) timeout: reset every time a chunk arrives, so a long but
// steadily-progressing generation is never killed — only a genuinely stalled
// connection (no bytes for this long) aborts. Reasoning models stream their
// "thinking" as delta.reasoning, which keeps this alive during long thinks.
const STREAM_IDLE_TIMEOUT_MS = 90_000;

/**
 * POST a chat completion with stream:true and consume the SSE, accumulating the
 * assistant content and any tool_calls. Returns once the stream ends. This is
 * the anti-timeout core: instead of one hard deadline on the whole request, we
 * only abort when the stream goes silent for STREAM_IDLE_TIMEOUT_MS.
 */
async function streamCompletion(payload: any, { purpose }: any = {}) {
  const controller = new AbortController();
  let idle: any;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error("stream idle timeout")), STREAM_IDLE_TIMEOUT_MS);
  };
  bump();

  let res: Response;
  try {
    res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llmApiKey}` },
      body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(idle);
    throw e;
  }
  if (!res.ok || !res.body) {
    clearTimeout(idle);
    const body = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 300)}`);
  }

  let content = "";
  const toolCalls: any[] = [];
  let usage: any = null;
  let finishReason: string | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === "string") content += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.type) toolCalls[i].type = tc.type;
            if (tc.function?.name) toolCalls[i].function.name = tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    clearTimeout(idle);
    try {
      reader.releaseLock();
    } catch {}
  }

  logLlmUsage(purpose ?? "unknown", usage);
  return { content, toolCalls: toolCalls.filter(Boolean), finishReason };
}

async function chat(messages, { purpose, temperature = 0.3 }: any = {}) {
  const { content } = await streamCompletion(
    {
      model: config.llmModel,
      messages,
      temperature,
      ...(config.llmReasoningEffort ? { reasoning_effort: config.llmReasoningEffort } : {}),
    },
    { purpose }
  );
  return content;
}

/**
 * Like chat(), but lets the model call skills before producing its final
 * answer. skills: array of { definition, execute } from src/skills/. Runs up
 * to maxRounds request/response cycles: model asks for a tool call -> we
 * execute it -> feed the result back -> model either answers or asks for
 * another tool call.
 */
async function chatWithTools(messages, { purpose, temperature = 0.3, maxRounds = 4, skills = [] }: any = {}) {
  const tools = skills.length ? skills.map((s) => s.definition) : undefined;
  const executors = new Map<string, any>(skills.map((s) => [s.definition.function.name, s.execute]));
  const msgs = [...messages];

  for (let round = 0; round < maxRounds; round++) {
    const { content, toolCalls } = await streamCompletion(
      {
        model: config.llmModel,
        messages: msgs,
        temperature,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
        ...(config.llmReasoningEffort ? { reasoning_effort: config.llmReasoningEffort } : {}),
      },
      { purpose }
    );

    if (!toolCalls.length) {
      return content;
    }

    msgs.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
    for (const call of toolCalls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        const execute = executors.get(call.function.name);
        result = execute ? await execute(args) : { error: "unknown tool" };
      } catch (err) {
        result = { error: String(err) };
      }
      console.log(`[llm] tool ${call.function.name}(${call.function.arguments}) ->`, JSON.stringify(result).slice(0, 200));
      msgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return "Maaf, butuh terlalu banyak langkah buat jawab ini. Coba tanya yang lebih spesifik.";
}

/**
 * John's eyes: a separate vision model describes the photo (including
 * transcribing any visible text), and the description is then fed into the
 * normal text chat flow — so the main model keeps its personality, memory
 * and skills while "seeing" what was sent.
 */
export async function describeImage(imageDataUrl, hint = "") {
  if (!config.llmVisionModel) return null;

  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmVisionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            {
              type: "text",
              text:
                "Deskripsikan foto ini secara lengkap tapi padat (dalam bahasa Indonesia): apa yang terlihat, " +
                "siapa/apa objek utamanya, suasana/konteksnya. Kalau ada teks yang terbaca (struk, screenshot, " +
                "tanda, dokumen), transkripsikan isinya selengkap mungkin. Jawab langsung deskripsinya saja." +
                (hint ? `\n\nKonteks dari pengirim: ${hint}` : ""),
            },
          ],
        },
      ],
      max_tokens: 1000,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Vision API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  logLlmUsage("vision", data.usage);
  return data.choices[0].message.content?.trim() || null;
}

/**
 * OCR a PDF that has no extractable text layer (scanned/image PDF). Uploads it
 * to the provider's Files API — which rasterises the PDF to one image per page
 * at upload time — then asks the vision model to transcribe every page. Reuses
 * the same aggregator + vision model as photos; no local OCR engine needed.
 * Returns the transcribed text (empty string if unavailable). The uploaded file
 * is deleted afterwards (privacy + housekeeping).
 */
export async function ocrPdfViaFiles(buffer: Buffer, fileName = "document.pdf"): Promise<string> {
  if (!config.llmVisionModel) return "";

  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: "application/pdf" }), fileName || "document.pdf");
  fd.append("purpose", "document");
  const up = await fetch(`${config.llmBaseUrl}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.llmApiKey}` },
    body: fd,
    signal: AbortSignal.timeout(120_000), // multi-page PDFs are rasterised per page at upload time
  });
  if (!up.ok) throw new Error(`file upload error ${up.status}: ${(await up.text().catch(() => "")).slice(0, 200)}`);
  const file = (await up.json()) as any;

  try {
    // Stream the transcription: a many-page deck can take a while, and the
    // idle-timeout keeps it alive as long as tokens flow (vs a hard 90s wall).
    const { content } = await streamCompletion(
      {
        model: config.llmVisionModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Ekstrak SELURUH teks dari dokumen ini apa adanya (semua halaman), pertahankan urutan dan " +
                  "struktur. Kalau ada tabel, tuliskan rapi baris per baris. Jangan menambahkan komentar, " +
                  "ringkasan, atau opini — keluarkan hanya teks yang ada di dokumen.",
              },
              { type: "file", file: { file_id: file.id } },
            ],
          },
        ],
        max_tokens: 8000,
      },
      { purpose: "vision" }
    );
    return (content || "").trim();
  } finally {
    fetch(`${config.llmBaseUrl}/files/${file.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.llmApiKey}` },
    }).catch(() => {});
  }
}

/**
 * Answer a question about a document the user just sent, in a single clean LLM
 * call that deliberately EXCLUDES the chat history. Some chats had the bot
 * wrongly refusing to read files ("upload to Drive"); that history primed it to
 * keep refusing even once the text was extracted. Answering from just the file
 * text + question sidesteps the poisoned history entirely.
 */
export async function answerAboutDocument(fileName, content, question, viaOcr = false) {
  const system =
    `Nama kamu ${config.botDisplayName}. Kamu BARU SAJA berhasil membaca sebuah file yang dikirim user langsung ` +
    `di WhatsApp${viaOcr ? " (PDF hasil scan/gambar, dibaca via OCR)" : ""} — jadi kamu MEMANG BISA membaca file yang ` +
    `dikirim di chat. Jawab pertanyaan user HANYA berdasarkan isi file di bawah. JANGAN pernah bilang kamu tidak bisa ` +
    `baca file/PDF dan JANGAN menyuruh upload ke Google Drive. Jawab ringkas dan jelas (ini WhatsApp, jawaban pendek), ` +
    `pakai bahasa yang sama dengan user. Format WhatsApp: *tebal* satu bintang, tanpa heading/tabel markdown.\n\n` +
    `Isi file "${fileName}":\n"""\n${content}\n"""`;
  return chat([{ role: "system", content: system }, { role: "user", content: question }], { purpose: "document" });
}

const URL_RE = /https?:\/\/[^\s)>\]]+/gi;

export function extractLinks(text) {
  if (!text) return [];
  return [...new Set(text.match(URL_RE) ?? [])];
}

/**
 * One combined pass over an incoming message: is it worth a note
 * (decision/deadline/key info) AND does it carry durable facts about the
 * sender? Used to be two separate LLM calls per message — merging them
 * halves the per-message overhead, and the fully static system prompt makes
 * repeat calls hit DeepSeek's automatic context cache.
 */
export async function analyzeMessage(text, senderDisplayName, { groupContext }: any = {}) {
  const none = { note: null, facts: [], join: false, joinReason: "" };
  // Short messages carry no notes/facts, but in a group they can still
  // warrant a join decision ("gimana dong?"), so only skip them when there's
  // no group context to judge against.
  if (!text || text.trim().length < (groupContext ? 3 : 10)) return none;

  const raw = await chat(
    [
      {
        role: "system",
        content:
          "You analyze one WhatsApp message and reply with strict JSON only:\n" +
          '{"note": string, "facts": [{"key": string, "value": string}], "join": boolean, "join_reason": string}\n' +
          "note: ONLY if the message contains genuinely important info (decision, deadline, action item, key fact, schedule) — " +
          'a summary under 25 words in the message\'s language. Otherwise "".\n' +
          "facts: durable facts ABOUT THE SENDER themselves (their name, job, preferences, important dates, " +
          "relationships, ongoing projects). NOT one-off requests, questions, or small talk; NOT facts about the " +
          'bot or about third parties mentioned in passing. Use short snake_case keys, reuse common keys like "name", ' +
          '"job", "birthday". Empty array if none. The sender\'s display name (possibly a nickname) is given by the user message prefix.\n' +
          `join: only meaningful when a "Percakapan grup terakhir" block is present — it means the assistant ` +
          `"${config.botDisplayName}" (a helpful bot in this group with tools for web search, weather, schedules, ` +
          "currency, calculations, reminders, files, etc.) was NOT addressed in the new message. Decide whether it " +
          "should chime in anyway. true ONLY when clearly valuable: (a) an open question or request that no human " +
          "has answered and the assistant can genuinely solve with its tools or knowledge, (b) the message talks " +
          "about the assistant or is implicitly directed at it, or (c) someone needs info the assistant likely has " +
          "saved. NEVER join casual banter between people, personal or emotional exchanges, or messages clearly " +
          "aimed at another specific person. When in doubt: false.\n" +
          'join_reason: short reason when join is true, otherwise "".',
      },
      {
        role: "user",
        content:
          `Pengirim: ${senderDisplayName}\nPesan: ${text}` +
          (groupContext
            ? `\n\nPercakapan grup terakhir (paling lama dulu):\n${groupContext}\n\n(Asisten TIDAK disebut/dipanggil di pesan baru ini.)`
            : ""),
      },
    ],
    { purpose: "analyze", temperature: 0 }
  );

  try {
    const parsed = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ""));
    return {
      note: parsed.note ? String(parsed.note) : null,
      facts: Array.isArray(parsed.facts) ? parsed.facts.filter((f) => f?.key && f?.value) : [],
      join: Boolean(groupContext) && parsed.join === true,
      joinReason: parsed.join_reason ? String(parsed.join_reason) : "",
    };
  } catch {
    return none;
  }
}

/**
 * Summarizes a list of {sender_name, text, created_at} messages into a
 * short structured summary (bullets: key points, links, action items).
 */
export async function summarizeMessages(messages, { label = "chat" } = {}) {
  if (messages.length === 0) return `Tidak ada pesan baru di ${label}.`;

  const transcript = messages
    .map((m) => `[${new Date(m.created_at).toLocaleString("id-ID")}] ${m.sender_name || m.sender_jid}: ${m.text}`)
    .join("\n");

  return chat(
    [
      {
        role: "system",
        content:
          "Kamu asisten yang meringkas percakapan WhatsApp jadi ringkasan singkat berbahasa Indonesia. " +
          "Format: beberapa bullet point berisi poin penting, keputusan, atau info kunci. " +
          "Kalau ada link, sertakan di bagian terpisah 'Link penting'. Kalau ada tenggat/rencana, sebutkan di 'Action items'. " +
          "Jangan mengarang informasi yang tidak ada di transkrip. " +
          "PENTING soal format teks: ini dikirim ke WhatsApp, BUKAN markdown biasa. " +
          "Bold pakai *satu bintang* (jangan **dua bintang**), jangan pakai heading (#), jangan pakai tabel markdown.",
      },
      { role: "user", content: `Ringkas percakapan ${label} berikut:\n\n${transcript}` },
    ],
    { purpose: "summarize" }
  );
}

/**
 * history: ordered (oldest -> newest) rows from getRecentHistory(), the last
 * one being the current incoming message. is_from_me distinguishes the bot's
 * own prior replies (assistant) from the user's messages (user).
 * facts: rows from getFacts(senderNumber) — persistent profile info about
 * whoever is CURRENTLY speaking, independent of how far back the
 * conversation history window reaches.
 * senderName: WhatsApp display name of whoever sent the current message —
 * needed so the model doesn't confuse its own name with the human's.
 *
 * Group chats have multiple humans in the same history window, but the
 * OpenAI "user" role has no per-message name field — without a name prefix
 * every non-bot turn looks like it came from the same person, which is how
 * the bot ends up replying to the wrong person or mixing two people up
 * mid-conversation. Prefixing each turn with its actual sender fixes that;
 * harmless no-op in a 1:1 DM where there's only ever one sender anyway.
 */
// Very long individual messages (pasted articles, long bot replies) bloat
// every subsequent request's history — clip them, the gist survives.
const MAX_HISTORY_MSG_CHARS = 800;

export async function answerQuestion(history, facts = [], senderName = "", notes = [], skills = [], docContext: any = null) {
  const turns = history.map((h) => {
    const clipped =
      h.text.length > MAX_HISTORY_MSG_CHARS ? h.text.slice(0, MAX_HISTORY_MSG_CHARS) + " [...dipotong]" : h.text;
    return {
      role: h.is_from_me ? "assistant" : "user",
      content: h.is_from_me ? clipped : `${h.sender_name || h.sender_number}: ${clipped}`,
    };
  });

  const factsBlock = facts.length
    ? `\n\nFakta yang kamu tahu tentang ${senderName || "orang ini"} (dari percakapan sebelumnya):\n${facts
        .map((f) => `- ${f.key}: ${f.value}`)
        .join("\n")}`
    : "";

  const notesBlock = notes.length
    ? `\n\nCatatan tersimpan yang relevan (dari chat ini dan grup lain yang diikuti orang ini, termasuk jadwal/link/info penting):\n${notes
        .map((n) => `- [${n.kind}] ${n.content}`)
        .join("\n")}`
    : "";

  const skillNames = skills.map((s) => s.definition.function.name);
  const skillsNote = skillNames.length
    ? `\n\nKamu punya skill/tools berikut: ${skillNames.join(", ")}. ` +
      "WAJIB pakai tool yang relevan daripada menebak atau mengarang: " +
      "info terkini/berita/harga -> web_search; cuaca -> get_weather; jadwal sholat -> get_prayer_times; " +
      "kurs/konversi mata uang -> convert_currency; hitung-hitungan -> calculator; " +
      "'ingetin aku...' -> set_reminder (pakai delay_seconds untuk waktu relatif, at_time untuk jam, repeat untuk harian/mingguan); " +
      "daftar tugas -> manage_todos; catat/simpan info -> save_note; ringkas chat -> summarize_chat; " +
      "jadwalin/lihat/ubah/hapus event kalender -> create_calendar_event/list_calendar_events/update_calendar_event/delete_calendar_event " +
      "(waktu HARUS ISO 8601 dengan offset timezone, hitung dari 'Hari ini' di atas; " +
      "kalau user tidak menyebut jam untuk event baru, TANYA dulu jamnya — jangan asal pilih jam sendiri); " +
      "bikin dokumen/tulisan yang bisa dibuka di browser atau dibagikan -> create_google_doc; " +
      "bikin SPREADSHEET BARU (tabel, daftar, rekap) -> create_google_sheet, BUKAN create_google_doc " +
      "(create_google_doc bikin dokumen teks biasa, bukan spreadsheet beneran walau isinya kamu tulis " +
      "sebagai tabel markdown — kalau user bilang 'spreadsheet', WAJIB create_google_sheet); " +
      "cari file di Google Drive user -> search_drive_files, lalu baca isinya -> read_drive_file " +
      "('cek feedback dari X', 'cari di gdrive' = pakai tools ini, jangan bilang tidak bisa; " +
      "kalau user minta LINK file/event yang pernah dibahas, panggil lagi tool-nya untuk ambil link asli — " +
      "jangan mengarang URL dan jangan bilang tidak punya); " +
      "ATURAN KERAS soal link Google Docs/Sheets/Drive: JANGAN PERNAH menulis URL docs.google.com, " +
      "drive.google.com, atau spreadsheet apa pun kecuali itu persis hasil 'url'/'link'/'webViewLink' dari " +
      "tool call yang BARU SAJA kamu panggil di giliran ini. Kalau user bilang link sebelumnya gagal/rusak/" +
      "gak bisa dibuka, JANGAN kasih link baru dari ingatan/karangan — panggil ulang tool-nya (buat ulang " +
      "atau cari lagi filenya) supaya link yang kamu kasih itu link asli yang baru dibuat. Mengarang link " +
      "sama parahnya dengan mengarang fakta. " +
      "film yang lagi tayang di bioskop -> get_now_playing_movies; jam tayang film di suatu kota -> get_movie_showtimes " +
      "(booking/bayar TIDAK bisa — arahkan ke app m.tix/TIX ID, lalu tawarkan bikin event kalender + reminder setelah user beli); " +
      "cek/baca email -> search_emails + read_email; kirim email -> send_email TAPI WAJIB tunjukkan draft " +
      "(penerima, subjek, isi) dan tunggu konfirmasi user dulu sebelum memanggil tool-nya; " +
      "baca spreadsheet -> read_sheet; catat data terstruktur (pengeluaran, log, dsb) ke spreadsheet yang SUDAH ADA " +
      "-> append_sheet_row (baca dulu sheet-nya kalau belum yakin urutan kolomnya); ubah/perbaiki/rombak isi " +
      "spreadsheet yang sudah ada, atau tambah tab baru di dalamnya -> update_sheet; spreadsheet BARU -> " +
      "create_google_sheet (lihat aturan di atas). " +
      "ATURAN ANTI-FILE-SAMPAH: JANGAN bikin file baru kalau topiknya sama dengan file yang sudah dibuat " +
      "sebelumnya di percakapan ini (atau yang sudah ada di Drive). 'Perbaiki/tambahin/yang lebih detail/" +
      "bikinin template yang bagus' tentang spreadsheet yang BARU SAJA dibuat = update_sheet (clear=true untuk " +
      "rombak total) ke file YANG SAMA, bukan create_google_sheet lagi. Data kategori lain yang masih satu " +
      "topik (misal budget untuk wedding yang sama) = tab baru via update_sheet di file yang sama, bukan file " +
      "baru. File baru HANYA kalau user eksplisit minta file terpisah atau topiknya beda sama sekali. " +
      "Satu permintaan = MAKSIMAL satu file baru. " +
      "cari video -> search_youtube; " +
      "lirik lagu -> get_song_lyrics (WAJIB — lirik dari ingatanmu hampir pasti salah, JANGAN PERNAH menulis " +
      "lirik tanpa tool ini; kalau tidak ketemu, bilang jujur tidak nemu); info lagu (album/tahun/genre/" +
      "preview) -> get_song_info; " +
      "GitHub: daftar repo -> list_github_repos, cek PR/issue/commit -> get_repo_activity (ada param branch), " +
      "daftar branch -> list_branches, bandingkan dua branch (commit & file berubah) -> compare_branches, " +
      "baca file/folder repo -> read_github_file (ada param ref untuk branch), " +
      "catat bug/task jadi issue -> create_github_issue (tunjukkan draft judul+isi dan tunggu konfirmasi user dulu). " +
      "foto di pesan/reply jadi sticker WA -> make_sticker; " +
      "Kalau ada tool get_server_status (hanya muncul untuk owner): dipakai saat owner tanya kondisi " +
      "server/VPS (uptime, RAM, disk, status bot). " +
      "Kalau ada tool run_shell_command (hanya untuk owner di DM): dipakai kalau owner minta melakukan sesuatu " +
      "di server (cek/edit file, kelola service, install, baca log, dll). Susun perintah shell lengkapnya " +
      "sendiri (boleh sudo). PENTING: tool ini cuma MENYIAPKAN perintah, TIDAK langsung menjalankan — setelah " +
      "memanggilnya, tampilkan perintah persisnya ke owner dan minta konfirmasi 'ya'; sistem yang akan " +
      "menjalankan setelah owner mengetik 'ya'. Jangan bilang perintah sudah jalan padahal belum. " +
      "Kalau ada tool build_app (hanya owner di DM): dipakai kalau owner minta dibikinin website/web app " +
      "('bikinin app/website ...') atau minta ubah app yang sudah ada (iterate=true + project_name yang sama). " +
      "Tulis description selengkap mungkin (semua fitur/halaman/gaya/data yang diminta) karena cuma itu yang " +
      "dilihat coding agent-nya. Build jalan async beberapa menit — setelah manggil tool, cukup bilang lagi " +
      "digarap dan link-nya bakal dikirim otomatis kalau jadi; JANGAN mengarang link atau bilang sudah jadi. " +
      "list_apps/app_status buat lihat daftar & status app. " +
      "Kalau tool sudah mengirim sesuatu sendiri (tag_all_members, create_poll, make_sticker), cukup konfirmasi singkat. " +
      "Kalau ada tool manage_whitelist (hanya muncul untuk owner): dipakai untuk menambah/menghapus/melihat " +
      "nomor yang boleh chat dengan kamu."
    : "\n\nKamu tidak punya akses internet real-time. Kalau ditanya sesuatu yang butuh info terkini " +
      "(rilis baru, berita terbaru, dll), bilang terus terang kamu tidak tahu info terbaru daripada menebak.";

  // Prompt order matters for cost: many providers (DeepSeek, and most
  // OpenAI-compatible aggregators) auto-cache any request prefix identical to
  // a previous request at a steep input-token discount. Everything static
  // (identity, rules, skills) therefore comes FIRST and byte-identical across
  // calls; everything that changes per message (date, sender, facts, notes)
  // is appended at the END.
  const staticHead =
    `Nama kamu adalah ${config.botDisplayName}, asisten pribadi lewat WhatsApp. ` +
    `Kalau ditanya kamu jalan di atas model/AI apa, jawab jujur: model "${config.llmModel}". ` +
    "Jangan pernah mengaku sebagai ChatGPT, GPT-4, GPT-4o, atau model OpenAI resmi lain yang bukan itu. " +
    "Kepribadian kamu konyol dan suka bercanda — gaya ngobrol kayak temen deket yang receh, bukan asisten " +
    "formal. TAPI ATURAN NOMOR SATU: ini chat WhatsApp, jawaban HARUS PENDEK. Default 1-3 kalimat; boleh " +
    "lebih panjang HANYA kalau user memang minta data/daftar/penjelasan yang isinya banyak. Candaan cukup " +
    "SATU selipan singkat per pesan, bukan stand-up comedy — JANGAN mengulang atau mendramatisir ulang " +
    "percakapan orang (format 'Rev: ...' / 'Audrey: ...' dilarang), jangan roasting bertubi-tubi. Emoji " +
    "maksimal 1 per pesan, sering-sering tanpa emoji sama sekali. Bold cuma untuk 1-2 kata yang benar-benar " +
    "penting — JANGAN bold hampir setiap kata. JANGAN menutup tiap pesan dengan tawaran/pertanyaan " +
    "follow-up ('mau aku bikinin event?', 'gas cek?') — tawarkan hanya kalau memang langkah lanjut yang " +
    "jelas dan baru, itupun sekali; kalau sudah pernah ditawarkan dan belum dijawab, jangan diulang. " +
    "Kalau topiknya serius (masalah/musibah), turunkan bercandanya. " +
    "Gunakan bahasa yang sama dengan pertanyaan user. " +
    "Kamu punya akses ke riwayat chat dan fakta tersimpan sebagai konteks — gunakan untuk " +
    "mengingat apa yang sudah dibahas, jangan bilang kamu tidak punya memori. " +
    "Pesan berisi foto muncul di riwayat sebagai '[foto: deskripsi]' atau '[membalas foto: deskripsi]' — " +
    "deskripsi itu hasil penglihatanmu sendiri, jadi jawab seolah kamu melihat fotonya langsung; " +
    "jangan pernah bilang kamu tidak bisa melihat gambar. " +
    "Jangan pernah tertukar antara nama kamu sendiri dan nama lawan bicara — " +
    `jika lawan bicara menyapa dengan nama "${config.botDisplayName}", itu memanggil KAMU, bukan diri mereka sendiri. ` +
    "Di riwayat chat grup, tiap pesan user diberi label 'Nama: isi pesan' — pakai itu untuk tahu SIAPA yang " +
    "sedang bicara ke kamu SEKARANG (lihat juga 'Lawan bicara saat ini' di bawah) dan siapa yang cuma DIBAHAS " +
    "atau disebut namanya di pesan itu. Sapa/pakai 'kamu' HANYA untuk orang yang sedang bicara ke kamu saat ini " +
    "— orang lain yang disebut namanya (baik di pesan sekarang maupun riwayat sebelumnya) selalu disebut pakai " +
    "namanya (orang ketiga), jangan disamakan atau ditukar dengan lawan bicara saat ini. " +
    "PENTING soal format teks: ini dikirim ke WhatsApp, BUKAN markdown biasa. " +
    "Bold pakai *satu bintang* (jangan **dua bintang**), italic pakai _garis bawah_, " +
    "jangan pakai heading (#) atau tabel markdown. " +
    "Kalau pesan-pesan kamu yang lama di riwayat melanggar aturan gaya di atas (kepanjangan, " +
    "bold di mana-mana, emoji banyak), JANGAN ditiru — aturan di atas yang menang. " +
    skillsNote;

  const docBlock = docContext
    ? `\n\n--- Dokumen yang baru dikirim user (kamu SUDAH membacanya) ---\n` +
      `File "${docContext.fileName}". Isi teksnya:\n"""\n${docContext.text}\n"""\n` +
      `Kalau user bertanya/minta sesuatu soal "file/dokumen/pptx/pdf ini/itu" (ringkas, buat cue card, ambil poin, dll), jawab dari isi di atas. JANGAN bilang kamu tidak bisa membaca file.`
    : "";

  const dynamicTail =
    `\n\n--- Konteks saat ini ---\n` +
    `Hari ini: ${new Date().toString()}\n` +
    `Lawan bicara saat ini: "${senderName}".` +
    factsBlock +
    notesBlock +
    docBlock;

  return chatWithTools([{ role: "system", content: staticHead + dynamicTail }, ...turns], {
    purpose: "chat",
    skills,
  });
}
