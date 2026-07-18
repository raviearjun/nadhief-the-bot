/**
 * Song skills — no API keys needed:
 * - Lyrics from LRCLIB (lrclib.net): free, open, full lyrics incl. Indonesian
 *   catalog. Exact /api/get lookup first, /api/search fallback (search is
 *   occasionally 503-overloaded; get has been solid).
 * - Song metadata from the iTunes Search API: artist/album/year/genre plus a
 *   30s preview link.
 * Exists because the chat model confidently invents lyrics from memory —
 * these tools give it something real to quote instead.
 */

const TIMEOUT_MS = 10_000;
// LRCLIB asks clients to identify themselves.
const LRCLIB_HEADERS = { "User-Agent": "john-the-bot/1.0 (personal WhatsApp assistant)" };
// WhatsApp handles long messages fine, but a full song is plenty.
const MAX_LYRICS_CHARS = 3_500;

function clip(lyrics) {
  if (lyrics.length <= MAX_LYRICS_CHARS) return lyrics;
  return lyrics.slice(0, MAX_LYRICS_CHARS) + "\n[...lirik dipotong]";
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getLyrics(artist, title) {
  // Exact match first — cheap and precise when the model knows both fields.
  try {
    const exact = await fetchJson(
      `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
      LRCLIB_HEADERS
    );
    if (exact.plainLyrics) {
      return {
        artist: exact.artistName,
        title: exact.trackName,
        album: exact.albumName || undefined,
        lyrics: clip(exact.plainLyrics),
        source: "LRCLIB",
      };
    }
  } catch {}

  try {
    const results = await fetchJson(
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${title} ${artist}`.trim())}`,
      LRCLIB_HEADERS
    );
    const hit = Array.isArray(results) ? results.find((r) => r.plainLyrics) : null;
    if (hit) {
      return {
        artist: hit.artistName,
        title: hit.trackName,
        album: hit.albumName || undefined,
        lyrics: clip(hit.plainLyrics),
        note: "hasil pencarian terdekat — konfirmasi judul/artisnya ke user kalau beda dari yang diminta",
        source: "LRCLIB",
      };
    }
  } catch (err) {
    return { error: `database lirik lagi tidak bisa diakses (${err.message}) — coba lagi nanti, JANGAN mengarang lirik` };
  }

  return { error: "lirik tidak ditemukan di database — bilang jujur tidak nemu, JANGAN menulis lirik dari ingatan" };
}

async function songInfo(query) {
  const data = await fetchJson(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=5`
  );
  const songs = (data.results ?? []).map((r) => ({
    artist: r.artistName,
    title: r.trackName,
    album: r.collectionName,
    year: r.releaseDate?.slice(0, 4),
    genre: r.primaryGenreName,
    duration_sec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
    preview_30s: r.previewUrl,
  }));
  if (songs.length === 0) return { error: "lagu tidak ditemukan" };
  return { songs };
}

export function skills() {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "get_song_lyrics",
          description:
            "Get the REAL lyrics of a song from the LRCLIB lyrics database. MANDATORY whenever the user asks " +
            "about lyrics, what a song says, or 'lagu yang liriknya ...' — NEVER write lyrics from memory, " +
            "they will be wrong. If this tool finds nothing, say so honestly instead of improvising.",
          parameters: {
            type: "object",
            properties: {
              artist: { type: "string", description: "Artist name, best guess ok" },
              title: { type: "string", description: "Song title" },
            },
            required: ["artist", "title"],
          },
        },
      },
      execute: ({ artist, title }) => getLyrics(artist ?? "", title ?? "").catch((err) => ({ error: err.message })),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "get_song_info",
          description:
            "Look up song metadata (artist, album, release year, genre, duration, 30-second preview link) " +
            "via the iTunes catalog. Use for 'lagu X itu tahun berapa/album apa/genre apa' or to verify a " +
            "song exists and how the title/artist is spelled before fetching lyrics.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Free-text search: title, artist, or both" },
            },
            required: ["query"],
          },
        },
      },
      execute: ({ query }) => songInfo(query ?? "").catch((err) => ({ error: err.message })),
    },
  ];
}
