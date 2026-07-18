import { config } from "./config.js";
import { logLlmUsage } from "./db.js";

const LLM_URL = `${config.llmBaseUrl}/chat/completions`;
// Without this, a stalled connection (this server's network has been flaky —
// see connection.js) leaves fetch() hanging forever: no error, no reply, the
// user just never hears back. Fail fast instead so callers can catch it.
// Reasoning models (gpt-oss-120b etc.) think before answering, so they get
// more headroom than a flash model would need.
const REQUEST_TIMEOUT_MS = 45_000;

async function chat(messages, { purpose, temperature = 0.3 } = {}) {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      temperature,
      ...(config.llmReasoningEffort ? { reasoning_effort: config.llmReasoningEffort } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  logLlmUsage(purpose ?? "unknown", data.usage);
  return data.choices[0].message.content;
}

/**
 * Like chat(), but lets the model call skills before producing its final
 * answer. skills: array of { definition, execute } from src/skills/. Runs up
 * to maxRounds request/response cycles: model asks for a tool call -> we
 * execute it -> feed the result back -> model either answers or asks for
 * another tool call.
 */
async function chatWithTools(messages, { purpose, temperature = 0.3, maxRounds = 4, skills = [] } = {}) {
  const tools = skills.length ? skills.map((s) => s.definition) : undefined;
  const executors = new Map(skills.map((s) => [s.definition.function.name, s.execute]));
  const msgs = [...messages];

  for (let round = 0; round < maxRounds; round++) {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: msgs,
        temperature,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
        ...(config.llmReasoningEffort ? { reasoning_effort: config.llmReasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    logLlmUsage(purpose ?? "unknown", data.usage);
    const message = data.choices[0].message;

    if (!message.tool_calls?.length) {
      return message.content;
    }

    msgs.push(message);
    for (const call of message.tool_calls) {
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
export async function analyzeMessage(text, senderDisplayName) {
  if (!text || text.trim().length < 10) return { note: null, facts: [] };

  const raw = await chat(
    [
      {
        role: "system",
        content:
          "You analyze one WhatsApp message and reply with strict JSON only:\n" +
          '{"note": string, "facts": [{"key": string, "value": string}]}\n' +
          "note: ONLY if the message contains genuinely important info (decision, deadline, action item, key fact, schedule) — " +
          'a summary under 25 words in the message\'s language. Otherwise "".\n' +
          "facts: durable facts ABOUT THE SENDER themselves (their name, job, preferences, important dates, " +
          "relationships, ongoing projects). NOT one-off requests, questions, or small talk; NOT facts about the " +
          'bot or about third parties mentioned in passing. Use short snake_case keys, reuse common keys like "name", ' +
          '"job", "birthday". Empty array if none. The sender\'s display name (possibly a nickname) is given by the user message prefix.',
      },
      { role: "user", content: `Pengirim: ${senderDisplayName}\nPesan: ${text}` },
    ],
    { purpose: "analyze", temperature: 0 }
  );

  try {
    const parsed = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ""));
    return {
      note: parsed.note ? String(parsed.note) : null,
      facts: Array.isArray(parsed.facts) ? parsed.facts.filter((f) => f?.key && f?.value) : [],
    };
  } catch {
    return { note: null, facts: [] };
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

export async function answerQuestion(history, facts = [], senderName = "", notes = [], skills = []) {
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
      "bikin dokumen/file yang bisa dibuka di browser atau dibagikan -> create_google_doc; " +
      "cari file di Google Drive user -> search_drive_files, lalu baca isinya -> read_drive_file " +
      "('cek feedback dari X', 'cari di gdrive' = pakai tools ini, jangan bilang tidak bisa; " +
      "kalau user minta LINK file/event yang pernah dibahas, panggil lagi tool-nya untuk ambil link asli — " +
      "jangan mengarang URL dan jangan bilang tidak punya); " +
      "film yang lagi tayang di bioskop -> get_now_playing_movies; jam tayang film di suatu kota -> get_movie_showtimes " +
      "(booking/bayar TIDAK bisa — arahkan ke app m.tix/TIX ID, lalu tawarkan bikin event kalender + reminder setelah user beli); " +
      "cek/baca email -> search_emails + read_email; kirim email -> send_email TAPI WAJIB tunjukkan draft " +
      "(penerima, subjek, isi) dan tunggu konfirmasi user dulu sebelum memanggil tool-nya; " +
      "baca spreadsheet -> read_sheet; catat data terstruktur (pengeluaran, log, dsb) ke spreadsheet -> append_sheet_row " +
      "(baca dulu sheet-nya kalau belum yakin urutan kolomnya); " +
      "cari video -> search_youtube; " +
      "GitHub: daftar repo -> list_github_repos, cek PR/issue/commit -> get_repo_activity (ada param branch), " +
      "daftar branch -> list_branches, bandingkan dua branch (commit & file berubah) -> compare_branches, " +
      "baca file/folder repo -> read_github_file (ada param ref untuk branch), " +
      "catat bug/task jadi issue -> create_github_issue (tunjukkan draft judul+isi dan tunggu konfirmasi user dulu). " +
      "Kalau tool sudah mengirim sesuatu sendiri (tag_all_members, create_poll), cukup konfirmasi singkat. " +
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
    "Jawab singkat, jelas, dan ramah. Gunakan bahasa yang sama dengan pertanyaan user. " +
    "Kamu punya akses ke riwayat chat dan fakta tersimpan sebagai konteks — gunakan untuk " +
    "mengingat apa yang sudah dibahas, jangan bilang kamu tidak punya memori. " +
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
    skillsNote;

  const dynamicTail =
    `\n\n--- Konteks saat ini ---\n` +
    `Hari ini: ${new Date().toString()}\n` +
    `Lawan bicara saat ini: "${senderName}".` +
    factsBlock +
    notesBlock;

  return chatWithTools([{ role: "system", content: staticHead + dynamicTail }, ...turns], {
    purpose: "chat",
    skills,
  });
}
