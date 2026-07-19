import { config } from "../config.js";

// YouTube Data API v3 with a plain API key — no OAuth needed for search.
const REQUEST_TIMEOUT_MS = 15_000;

async function searchYoutube(query, maxResults) {
  const params = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    maxResults: String(Math.min(Math.max(Number(maxResults) || 5, 1), 10)),
    key: config.youtubeApiKey,
  });
  const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { error: `YouTube API error ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = await res.json() as any;
  return {
    videos: (data.items ?? []).map((v) => ({
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      published: v.snippet.publishedAt?.slice(0, 10),
      link: `https://youtu.be/${v.id.videoId}`,
    })),
  };
}

export function skills() {
  if (!config.youtubeApiKey) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "search_youtube",
          description:
            "Search YouTube videos. Use for 'carikan video/tutorial ...', 'ada video tentang X gak?'. " +
            "Returns titles, channels, and youtu.be links.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search keywords" },
              max_results: { type: "number", description: "Max videos, default 5" },
            },
            required: ["query"],
          },
        },
      },
      execute: ({ query, max_results }) => searchYoutube(query, max_results).catch((err) => ({ error: err.message })),
    },
  ];
}
