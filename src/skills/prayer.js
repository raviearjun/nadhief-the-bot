const REQUEST_TIMEOUT_MS = 15_000;

// method 20 = KEMENAG (Kementerian Agama RI) calculation — the standard for Indonesia
async function getPrayerTimes(city, country) {
  const params = new URLSearchParams({ city, country: country || "Indonesia", method: "20" });
  const res = await fetch(`https://api.aladhan.com/v1/timingsByCity?${params}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return { error: `prayer times fetch failed with status ${res.status}` };
  const data = await res.json();
  const t = data.data?.timings;
  if (!t) return { error: "no prayer times returned for that city" };

  return {
    city,
    date: data.data.date?.readable,
    hijri: data.data.date?.hijri ? `${data.data.date.hijri.day} ${data.data.date.hijri.month.en} ${data.data.date.hijri.year}` : null,
    timings: {
      subuh: t.Fajr,
      terbit: t.Sunrise,
      dzuhur: t.Dhuhr,
      ashar: t.Asr,
      maghrib: t.Maghrib,
      isya: t.Isha,
    },
  };
}

export function skills() {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "get_prayer_times",
          description:
            "Get today's Islamic prayer times (jadwal sholat: subuh, dzuhur, ashar, maghrib, isya) for a city. " +
            "Uses the Indonesian KEMENAG calculation method by default.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name, e.g. \"Jakarta\"" },
              country: { type: "string", description: "Country name, defaults to Indonesia" },
            },
            required: ["city"],
          },
        },
      },
      execute: ({ city, country }) => getPrayerTimes(city, country),
    },
  ];
}
