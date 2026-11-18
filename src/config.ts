import "dotenv/config";

function required(name: string, fallback?: string) {
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
  // Other bots' numbers to never reply to (comma-separated) — stops two
  // assistants ping-ponging each other into a loop. Normalised to 628xx.
  ignoreNumbers: (process.env.IGNORE_NUMBERS || "")
    .split(",")
    .map((s) => {
      let n = s.replace(/\D/g, "");
      if (n.startsWith("0")) n = "62" + n.slice(1);
      return n;
    })
    .filter(Boolean),
  // Separate vision-capable model on the same endpoint (the chat model stays
  // text-only). Empty = photo understanding disabled.
  llmVisionModel: process.env.LLM_VISION_MODEL || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "", // optional — web search tool disabled if empty
  exaApiKey: process.env.EXA_API_KEY || "", // optional — find_companies (Exa lead-gen) disabled if empty
  daytonaApiKey: process.env.DAYTONA_API_KEY || "", // optional — run_code (Daytona sandbox) disabled if empty
  youtubeApiKey: process.env.YOUTUBE_API_KEY || "", // optional — YouTube search skill disabled if empty
  githubToken: process.env.GITHUB_TOKEN || "", // optional — GitHub skills disabled if empty
  ownerNumber: required("OWNER_NUMBER"), // e.g. "6281234567890"
  botDisplayName: process.env.BOT_TRIGGER_NAME || "Bot", // original casing, for prompts
  botTriggerName: (process.env.BOT_TRIGGER_NAME || "bot").toLowerCase(), // lowercased, for matching
  // Auto-reply persona (DMs from whitelisted non-owners): the bot answers as the
  // owner's assistant instead of as "John". The profile file holds what the
  // assistant may say about the owner — it never invents anything beyond it.
  ownerName: process.env.OWNER_NAME || "pemilik nomor ini",
  personaFile: process.env.PERSONA_FILE || "persona.md",
  // Prepended to every auto-reply so friends can tell it's the assistant, not
  // the owner typing. Set AUTOREPLY_TAG= (empty) to disable.
  autoReplyTag: process.env.AUTOREPLY_TAG ?? "🤖 ",
  // Human takeover: when the owner types in a DM, the bot goes silent in that
  // chat for this long (then resumes by itself).
  takeoverMuteMs: Number(process.env.TAKEOVER_MUTE_HOURS ?? 3) * 3_600_000,
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
