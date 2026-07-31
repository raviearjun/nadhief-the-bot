import { config } from "../config.js";
import { logLlmUsage } from "../db.js";

/**
 * Business/lead-generation search via Exa (https://exa.ai). Uses Exa's
 * `category: "company"` to find real companies matching a natural-language
 * description — potential B2B sales prospects, market research, etc. Returns
 * name + website + a short description per company. Disabled unless EXA_API_KEY
 * is set.
 */

const REQUEST_TIMEOUT_MS = 30_000;

async function findCompanies({ query, country, numResults }: any) {
  if (!query) return { error: "query kosong — jelaskan perusahaan yang dicari" };
  logLlmUsage("exa_company_search", null); // call-count visibility; Exa billed separately

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.exaApiKey}` },
    body: JSON.stringify({
      query,
      type: "auto",
      category: "company",
      numResults: Math.min(Math.max(Number(numResults) || 10, 1), 25),
      ...(country ? { userLocation: String(country).toUpperCase().slice(0, 2) } : {}),
      contents: { summary: true },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { error: `Exa search gagal (status ${res.status})${body ? ": " + body.slice(0, 150) : ""}` };
  }

  const data = (await res.json()) as any;
  const companies = (data.results ?? []).map((r: any) => ({
    name: r.title || r.url,
    url: r.url,
    description: r.summary || r.highlights?.[0] || null,
  }));
  if (!companies.length) return { count: 0, companies: [], note: "tidak ada perusahaan yang cocok — coba longgarkan/ubah kriteria" };
  return { count: companies.length, companies };
}

export function skills() {
  if (!config.exaApiKey) return [];
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "find_companies",
          description:
            "Cari daftar PERUSAHAAN nyata di web (via Exa) untuk keperluan bisnis/penjualan: lead generation, " +
            "prospek B2B, riset pasar, cari calon pembeli/partner/supplier. Pakai untuk permintaan seperti " +
            "'cari perusahaan yang berpotensi beli produk X', 'perusahaan katering di Jakarta', 'startup " +
            "agritech yang baru dapat pendanaan', 'hotel bintang 5 di Bali', 'distributor kopi di Indonesia'. " +
            "Susun query sedetail mungkin (industri, lokasi, ukuran, ciri, kebutuhan) — kamu boleh menerjemahkan " +
            "maksud user jadi query yang lebih tajam. Mengembalikan nama perusahaan, website, dan deskripsi singkat; " +
            "ringkas hasilnya buat user dan sebutkan websitenya.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Deskripsi natural perusahaan yang dicari — makin spesifik makin bagus (industri, lokasi, ciri, kebutuhan). Boleh Inggris atau Indonesia.",
              },
              country: { type: "string", description: "Kode negara ISO 2 huruf untuk fokus lokasi, mis. 'ID' (Indonesia), 'US'. Opsional." },
              numResults: { type: "integer", description: "Jumlah perusahaan yang diminta (1-25, default 10)." },
            },
            required: ["query"],
          },
        },
      },
      execute: (args: any) => findCompanies(args || {}),
    },
  ];
}
