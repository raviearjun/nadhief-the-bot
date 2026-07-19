const REQUEST_TIMEOUT_MS = 15_000;

// WMO weather interpretation codes -> short Indonesian description
const WMO = {
  0: "cerah",
  1: "cerah berawan",
  2: "berawan sebagian",
  3: "berawan",
  45: "berkabut",
  48: "kabut tebal",
  51: "gerimis ringan",
  53: "gerimis",
  55: "gerimis lebat",
  61: "hujan ringan",
  63: "hujan",
  65: "hujan lebat",
  66: "hujan es ringan",
  67: "hujan es",
  71: "salju ringan",
  73: "salju",
  75: "salju lebat",
  80: "hujan lokal ringan",
  81: "hujan lokal",
  82: "hujan lokal lebat",
  95: "badai petir",
  96: "badai petir + hujan es",
  99: "badai petir hebat",
};

const describe = (code) => WMO[code] ?? `kode cuaca ${code}`;

async function getWeather(city) {
  const geoRes = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  if (!geoRes.ok) return { error: `geocoding failed with status ${geoRes.status}` };
  const geo = await geoRes.json() as any;
  const place = geo.results?.[0];
  if (!place) return { error: `city "${city}" not found` };

  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: "3",
    timezone: "auto",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) return { error: `weather fetch failed with status ${res.status}` };
  const data = await res.json() as any;

  return {
    location: `${place.name}${place.admin1 ? ", " + place.admin1 : ""}, ${place.country}`,
    now: {
      temperature_c: data.current.temperature_2m,
      humidity_pct: data.current.relative_humidity_2m,
      wind_kmh: data.current.wind_speed_10m,
      condition: describe(data.current.weather_code),
    },
    daily_forecast: data.daily.time.map((date, i) => ({
      date,
      condition: describe(data.daily.weather_code[i]),
      min_c: data.daily.temperature_2m_min[i],
      max_c: data.daily.temperature_2m_max[i],
      rain_chance_pct: data.daily.precipitation_probability_max[i],
    })),
  };
}

export function skills() {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "get_weather",
          description:
            "Get current weather and a 3-day forecast for a city (worldwide, via Open-Meteo). " +
            "Use whenever the user asks about weather, rain, or temperature.",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name, e.g. \"Jakarta\" or \"Bandung\"" },
            },
            required: ["city"],
          },
        },
      },
      execute: ({ city }) => getWeather(city),
    },
  ];
}
