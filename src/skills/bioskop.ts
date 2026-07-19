// Cinema showtimes for Indonesian theaters (XXI / CGV / Cinepolis), scraped
// from jadwalnonton.com — neither Cinema XXI nor TIX ID exposes a public
// API, and their consumer sites are app-only. Booking itself stays with the
// user (payment + OTP in the m.tix / TIX ID app); this only finds schedules.
const BASE = "https://jadwalnonton.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;

const BOOKING_NOTE =
  "Booking/bayar tidak bisa dilakukan bot — arahkan user beli di app m.tix (XXI), TIX ID, atau CGV. " +
  "Setelah user konfirmasi beli, tawarkan bikin event Google Calendar + reminder.";

function citySlug(city) {
  return String(city ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

const normalize = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch ${url} failed with status ${res.status}`);
  return res.text();
}

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

function parseNowPlaying(html) {
  const movies = [];
  const re = /<h2><a href="(https:\/\/jadwalnonton\.com\/film\/[^"]+)" title="([^"]+)">/g;
  for (const m of html.matchAll(re)) movies.push({ title: decodeEntities(m[2]), link: m[1] });
  return movies;
}

function parseShowtimes(html) {
  const theaters = [];
  const chunks = html.split('<div class="item" data-key=').slice(1);
  for (const chunk of chunks) {
    const head = chunk.match(/<h2><a href="[^"]*">([^<]+)<\/a><span class="thlogo ([a-z]+)"/);
    if (!head) continue;
    const price = chunk.match(/Tiket Rp\.? ?([\d.,]+)/)?.[1] ?? null;
    const times = [...chunk.matchAll(/data-tm="(\d{1,2}:\d{2})"/g)].map((t) => t[1]);
    if (times.length === 0) continue;
    theaters.push({
      theater: head[1].trim(),
      chain: head[2].toUpperCase(),
      ticket_price: price ? `Rp ${price}` : null,
      times: [...new Set(times)],
    });
  }
  return theaters;
}

async function nowPlaying(city) {
  const slug = citySlug(city);
  if (!slug) return { error: "city is required, e.g. bandung / jakarta / surabaya" };
  let html;
  try {
    html = await fetchHtml(`${BASE}/now-playing/in-${slug}/`);
  } catch {
    return { error: `kota "${city}" tidak ditemukan di jadwalnonton.com — coba nama kota besar terdekat` };
  }
  const movies = parseNowPlaying(html);
  if (movies.length === 0) return { error: "gagal membaca daftar film (struktur situs mungkin berubah) — coba web_search" };
  return { city, date: "hari ini", movies: movies.map((m) => m.title), note: BOOKING_NOTE };
}

async function showtimes(movie, city) {
  const slug = citySlug(city);
  if (!slug) return { error: "city is required, e.g. bandung / jakarta / surabaya" };
  let listHtml;
  try {
    listHtml = await fetchHtml(`${BASE}/now-playing/in-${slug}/`);
  } catch {
    return { error: `kota "${city}" tidak ditemukan di jadwalnonton.com — coba nama kota besar terdekat` };
  }

  const movies = parseNowPlaying(listHtml);
  const wanted = normalize(movie);
  const found =
    movies.find((m) => normalize(m.title) === wanted) ??
    movies.find((m) => normalize(m.title).includes(wanted) || wanted.includes(normalize(m.title)));
  if (!found) {
    return {
      error: `film "${movie}" tidak sedang tayang di ${city}`,
      now_playing: movies.map((m) => m.title),
    };
  }

  const scheduleUrl = `${found.link.replace(/\/$/, "")}/di-${slug}/`;
  const theaters = parseShowtimes(await fetchHtml(scheduleUrl));
  if (theaters.length === 0) {
    return { error: `jadwal "${found.title}" di ${city} kosong untuk hari ini`, movie: found.title };
  }

  return {
    movie: found.title,
    city,
    date: "hari ini",
    schedule_page: scheduleUrl,
    theaters: theaters.slice(0, 12),
    note: BOOKING_NOTE,
  };
}

export function skills() {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "get_now_playing_movies",
          description:
            "List movies currently playing in Indonesian cinemas (XXI/CGV/Cinepolis) in a given city. " +
            "Use for 'film apa aja yang tayang di <kota>?'.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "Indonesian city name, e.g. bandung, jakarta, surabaya" },
            },
            required: ["city"],
          },
        },
      },
      execute: ({ city }) => nowPlaying(city).catch((err) => ({ error: err.message })),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "get_movie_showtimes",
          description:
            "Get today's showtimes (theater, times, ticket price) for a specific movie in a city " +
            "(XXI/CGV/Cinepolis). Use for 'Spider-Man tayang jam berapa di Bandung?'.",
          parameters: {
            type: "object",
            properties: {
              movie: { type: "string", description: "Movie title (approximate ok)" },
              city: { type: "string", description: "Indonesian city name" },
            },
            required: ["movie", "city"],
          },
        },
      },
      execute: ({ movie, city }) => showtimes(movie, city).catch((err) => ({ error: err.message })),
    },
  ];
}
