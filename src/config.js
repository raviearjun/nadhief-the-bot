import "dotenv/config";

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  // OpenAI-compatible chat completions endpoint — swap provider/model via env,
  // no code changes needed (see wabot/src/llm.js).
  llmBaseUrl: (process.env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/$/, ""),
  llmApiKey: required("LLM_API_KEY"),
  llmModel: process.env.LLM_MODEL || "deepseek-chat",
  // Only sent to the API when set — reasoning models (e.g. gpt-oss-120b) accept
  // low/medium/high; non-reasoning models ignore or reject unknown fields, so
  // leave unset unless the configured model actually supports it.
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "", // optional — web search tool disabled if empty
  youtubeApiKey: process.env.YOUTUBE_API_KEY || "", // optional — YouTube search skill disabled if empty
  githubToken: process.env.GITHUB_TOKEN || "", // optional — GitHub skills disabled if empty
  ownerNumber: required("OWNER_NUMBER"), // e.g. "6281234567890"
  botDisplayName: process.env.BOT_TRIGGER_NAME || "Bot", // original casing, for prompts
  botTriggerName: (process.env.BOT_TRIGGER_NAME || "bot").toLowerCase(), // lowercased, for matching
  reminderHour: Number(process.env.REMINDER_HOUR ?? 7),
  reminderMinute: Number(process.env.REMINDER_MINUTE ?? 0),
  adminUsername: required("ADMIN_USERNAME", "admin"),
  adminPassword: required("ADMIN_PASSWORD", "changeme"),
  sessionSecret: required("SESSION_SECRET", "dev-secret-change-me"),
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST || "0.0.0.0", // 0.0.0.0 default keeps Daytona's preview proxy working

  // Google Calendar OAuth — optional, calendar skill disables itself if unset.
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/google/callback",
};
