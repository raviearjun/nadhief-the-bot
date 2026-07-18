import { config } from "../config.js";
import { logLlmUsage } from "../db.js";

const REQUEST_TIMEOUT_MS = 15_000;

async function tavilySearch(query) {
  logLlmUsage("web_search", null); // separate cost/quota from Tavily, tracked here just for call-count visibility

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: config.tavilyApiKey,
      query,
      max_results: 5,
      include_answer: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) return { error: `search failed with status ${res.status}` };

  const data = await res.json();
  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content })),
  };
}

export function skills() {
  if (!config.tavilyApiKey) return [];
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "web_search",
          description:
            "Search the live web for current, recent, or time-sensitive information (new releases, news, " +
            "prices, schedules, scores, anything that could have changed after your training data). " +
            "Always use this instead of guessing when the question depends on what's true right now.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "The search query" } },
            required: ["query"],
          },
        },
      },
      execute: ({ query }) => tavilySearch(query),
    },
  ];
}
