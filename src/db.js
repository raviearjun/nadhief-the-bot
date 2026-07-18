import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data.sqlite");

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

// Migrate facts table from the old per-chat schema (facts blended across
// everyone in a group) to the new per-person schema, keyed by phone number.
try {
  const cols = db.prepare(`PRAGMA table_info(facts)`).all();
  if (cols.some((c) => c.name === "chat_jid")) {
    db.exec("DROP TABLE facts");
  }
} catch {}

// Add cache_hit_tokens to llm_usage if missing — tracks how much of the
// prompt was served from the provider's context cache (much cheaper input).
try {
  const cols = db.prepare(`PRAGMA table_info(llm_usage)`).all();
  if (cols.length && !cols.some((c) => c.name === "cache_hit_tokens")) {
    db.exec("ALTER TABLE llm_usage ADD COLUMN cache_hit_tokens INTEGER NOT NULL DEFAULT 0");
  }
} catch {}

// Add repeat to reminders if missing — 'daily' / 'weekly' reminders reschedule
// themselves instead of being marked sent.
try {
  const cols = db.prepare(`PRAGMA table_info(reminders)`).all();
  if (cols.length && !cols.some((c) => c.name === "repeat")) {
    db.exec("ALTER TABLE reminders ADD COLUMN repeat TEXT");
  }
} catch {}

// Add sender_number to messages if missing — resolved phone number (not the
// raw, sometimes-@lid jid), needed to look up "which groups has this person
// talked in" so notes/schedules mentioned in a group are still recognized
// when the same person messages the bot directly.
try {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all();
  if (cols.length && !cols.some((c) => c.name === "sender_number")) {
    db.exec("ALTER TABLE messages ADD COLUMN sender_number TEXT");
  }
} catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  chat_name TEXT,
  sender_jid TEXT,
  sender_name TEXT,
  sender_number TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  text TEXT,
  is_from_me INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages (chat_jid, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender_group ON messages (sender_number, is_group);

CREATE TABLE IF NOT EXISTS whitelist (
  number TEXT PRIMARY KEY,
  label TEXT,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  message TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  repeat TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (sent, fire_at);

CREATE TABLE IF NOT EXISTS contacts (
  number TEXT PRIMARY KEY,
  display_name TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  person_number TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (person_number, key)
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_number TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_person ON todos (person_number, done);

CREATE TABLE IF NOT EXISTS group_settings (
  chat_jid TEXT PRIMARY KEY,
  summary_hour INTEGER,
  summary_minute INTEGER NOT NULL DEFAULT 0
);

-- WhatsApp privacy LIDs: some events identify a sender only by an opaque
-- @lid id. When a message carries both the lid and the real number, remember
-- the pair so later lid-only messages can still be matched to the whitelist.
CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Single-row table: one Google account connected via the admin dashboard,
-- shared by the bot (not per-contact) — matches "connect your calendar" as
-- an admin action, same account for every chat's calendar skill calls.
CREATE TABLE IF NOT EXISTS google_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  expiry_date INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Per-chat knobs for proactive mode (bot joining a group conversation
-- without being mentioned): on/off toggle, temporary mute, and the
-- timestamp of the last uninvited interjection (for the cooldown).
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_jid TEXT PRIMARY KEY,
  proactive INTEGER NOT NULL DEFAULT 1,
  muted_until INTEGER NOT NULL DEFAULT 0,
  last_unsolicited_at INTEGER NOT NULL DEFAULT 0
);
`);

export function insertMessage(msg) {
  const res = db
    .prepare(
      `INSERT INTO messages (chat_jid, chat_name, sender_jid, sender_name, sender_number, is_group, text, is_from_me, created_at)
       VALUES (@chat_jid, @chat_name, @sender_jid, @sender_name, @sender_number, @is_group, @text, @is_from_me, @created_at)`
    )
    .run({ sender_number: null, ...msg });
  return Number(res.lastInsertRowid);
}

// Used to enrich a stored photo message with its vision description once
// generated, so chat history (and future "foto yang tadi" questions) see it.
export function updateMessageText(id, text) {
  db.prepare(`UPDATE messages SET text = ? WHERE id = ?`).run(text, id);
}

export function getRecentMessages(chatJid, sinceTs, limit = 200) {
  return db
    .prepare(
      `SELECT * FROM messages WHERE chat_jid = ? AND created_at >= ? ORDER BY created_at ASC LIMIT ?`
    )
    .all(chatJid, sinceTs, limit);
}

export function getRecentHistory(chatJid, limit = 20) {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE chat_jid = ? ORDER BY created_at DESC LIMIT ?`)
    .all(chatJid, limit);
  return rows.reverse(); // chronological order for feeding to the LLM
}

export function getAllChatsSince(sinceTs) {
  return db
    .prepare(
      `SELECT DISTINCT chat_jid, chat_name FROM messages WHERE created_at >= ?`
    )
    .all(sinceTs);
}

// Normalize a phone number for whitelist matching: strip everything but
// digits and convert the Indonesian local 08xx prefix to international
// 628xx — so "0812-3456-7890" and "6281234567890" are the same entry.
// Without this, numbers added in local format never match what WhatsApp
// sends and the person is silently locked out.
export function normalizeNumber(raw) {
  let n = String(raw ?? "").replace(/\D/g, "");
  if (n.startsWith("0")) n = "62" + n.slice(1);
  return n;
}

export function isWhitelisted(number) {
  return !!db.prepare(`SELECT 1 FROM whitelist WHERE number = ?`).get(normalizeNumber(number));
}

export function addToWhitelist(number, label = "") {
  db.prepare(
    `INSERT OR REPLACE INTO whitelist (number, label, added_at) VALUES (?, ?, ?)`
  ).run(normalizeNumber(number), label, Date.now());
}

export function removeFromWhitelist(number) {
  db.prepare(`DELETE FROM whitelist WHERE number = ?`).run(normalizeNumber(number));
}

export function listWhitelist() {
  return db.prepare(`SELECT * FROM whitelist ORDER BY added_at DESC`).all();
}

export function addNote(chatJid, content, kind = "note") {
  db.prepare(
    `INSERT INTO notes (chat_jid, kind, content, created_at) VALUES (?, ?, ?, ?)`
  ).run(chatJid, kind, content, Date.now());
}

export function listNotes(chatJid, limit = 100) {
  return db
    .prepare(
      `SELECT * FROM notes WHERE chat_jid = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(chatJid, limit);
}

// Distinct group chats this person has actually spoken in — so a DM with
// them can also surface notes/schedules mentioned in "their" groups instead
// of only what was said in the DM thread itself.
export function getGroupChatsForPerson(personNumber) {
  return db
    .prepare(`SELECT DISTINCT chat_jid FROM messages WHERE sender_number = ? AND is_group = 1`)
    .all(personNumber)
    .map((r) => r.chat_jid);
}

export function getNotesForChats(chatJids, limit = 30) {
  if (chatJids.length === 0) return [];
  const placeholders = chatJids.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM notes WHERE chat_jid IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
    .all(...chatJids, limit);
}

export function upsertLidMapping(lid, number) {
  db.prepare(
    `INSERT INTO lid_map (lid, number, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(lid) DO UPDATE SET number = excluded.number, updated_at = excluded.updated_at`
  ).run(lid, number, Date.now());
}

export function getNumberForLid(lid) {
  return db.prepare(`SELECT number FROM lid_map WHERE lid = ?`).get(lid)?.number ?? null;
}

export function logLlmUsage(purpose, usage) {
  db.prepare(
    `INSERT INTO llm_usage (purpose, prompt_tokens, completion_tokens, total_tokens, cache_hit_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    purpose,
    usage?.prompt_tokens ?? 0,
    usage?.completion_tokens ?? 0,
    usage?.total_tokens ?? 0,
    usage?.prompt_cache_hit_tokens ?? 0,
    Date.now()
  );
}

export function getUsageStats() {
  const totals = db
    .prepare(
      `SELECT COUNT(*) as calls, SUM(prompt_tokens) as prompt_tokens,
              SUM(completion_tokens) as completion_tokens, SUM(total_tokens) as total_tokens,
              SUM(cache_hit_tokens) as cache_hit_tokens
       FROM llm_usage`
    )
    .get();
  const byPurpose = db
    .prepare(
      `SELECT purpose, COUNT(*) as calls, SUM(total_tokens) as total_tokens
       FROM llm_usage GROUP BY purpose`
    )
    .all();
  const recent = db
    .prepare(`SELECT * FROM llm_usage ORDER BY created_at DESC LIMIT 50`)
    .all();
  return { totals, byPurpose, recent };
}

export function saveSummary(chatJid, content) {
  db.prepare(
    `INSERT INTO summaries (chat_jid, content, created_at) VALUES (?, ?, ?)`
  ).run(chatJid, content, Date.now());
}

export function upsertContact(number, displayName) {
  db.prepare(
    `INSERT INTO contacts (number, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(number) DO UPDATE SET display_name = excluded.display_name, last_seen = excluded.last_seen`
  ).run(number, displayName || null, Date.now(), Date.now());
}

export function listContacts() {
  return db.prepare(`SELECT * FROM contacts ORDER BY last_seen DESC`).all();
}

export function upsertFact(personNumber, key, value) {
  db.prepare(
    `INSERT INTO facts (person_number, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(person_number, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(personNumber, key, value, Date.now());
}

export function getFacts(personNumber) {
  return db
    .prepare(`SELECT key, value, updated_at FROM facts WHERE person_number = ? ORDER BY key`)
    .all(personNumber);
}

export function addReminder(chatJid, message, fireAt, repeat = null) {
  db.prepare(
    `INSERT INTO reminders (chat_jid, message, fire_at, sent, repeat, created_at) VALUES (?, ?, ?, 0, ?, ?)`
  ).run(chatJid, message, fireAt, repeat, Date.now());
}

export function getPendingReminders(chatJid) {
  return db
    .prepare(`SELECT id, message, fire_at, repeat FROM reminders WHERE chat_jid = ? AND sent = 0 ORDER BY fire_at ASC`)
    .all(chatJid);
}

// Scoped to the chat so a reminder can only be cancelled from where it was set.
export function cancelReminder(id, chatJid) {
  const res = db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ? AND chat_jid = ? AND sent = 0`).run(id, chatJid);
  return res.changes > 0;
}

export function rescheduleReminder(id, nextFireAt) {
  db.prepare(`UPDATE reminders SET fire_at = ? WHERE id = ?`).run(nextFireAt, id);
}

export function getDueReminders(now) {
  return db
    .prepare(`SELECT * FROM reminders WHERE sent = 0 AND fire_at <= ? ORDER BY fire_at ASC`)
    .all(now);
}

export function markReminderSent(id) {
  db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`).run(id);
}

export function addTodo(personNumber, text) {
  const res = db
    .prepare(`INSERT INTO todos (person_number, text, done, created_at) VALUES (?, ?, 0, ?)`)
    .run(personNumber, text, Date.now());
  return Number(res.lastInsertRowid);
}

export function listTodos(personNumber, includeDone = false) {
  return db
    .prepare(
      `SELECT id, text, done FROM todos WHERE person_number = ? ${includeDone ? "" : "AND done = 0"} ORDER BY done ASC, created_at ASC`
    )
    .all(personNumber);
}

export function setTodoDone(id, personNumber) {
  const res = db.prepare(`UPDATE todos SET done = 1 WHERE id = ? AND person_number = ?`).run(id, personNumber);
  return res.changes > 0;
}

export function removeTodo(id, personNumber) {
  const res = db.prepare(`DELETE FROM todos WHERE id = ? AND person_number = ?`).run(id, personNumber);
  return res.changes > 0;
}

// Scoped to the chat so notes can only be deleted from the chat they belong to.
export function deleteNote(id, chatJid) {
  const res = db.prepare(`DELETE FROM notes WHERE id = ? AND chat_jid = ?`).run(id, chatJid);
  return res.changes > 0;
}

export function setGroupSummaryTime(chatJid, hour, minute) {
  db.prepare(
    `INSERT INTO group_settings (chat_jid, summary_hour, summary_minute) VALUES (?, ?, ?)
     ON CONFLICT(chat_jid) DO UPDATE SET summary_hour = excluded.summary_hour, summary_minute = excluded.summary_minute`
  ).run(chatJid, hour, minute);
}

export function disableGroupSummary(chatJid) {
  db.prepare(`UPDATE group_settings SET summary_hour = NULL WHERE chat_jid = ?`).run(chatJid);
}

export function getGroupsWithSummaryAt(hour, minute) {
  return db
    .prepare(`SELECT chat_jid FROM group_settings WHERE summary_hour = ? AND summary_minute = ?`)
    .all(hour, minute)
    .map((r) => r.chat_jid);
}

export function getChatSettings(chatJid) {
  return (
    db.prepare(`SELECT * FROM chat_settings WHERE chat_jid = ?`).get(chatJid) ?? {
      chat_jid: chatJid,
      proactive: 1,
      muted_until: 0,
      last_unsolicited_at: 0,
    }
  );
}

export function updateChatSettings(chatJid, patch) {
  const next = { ...getChatSettings(chatJid), ...patch };
  db.prepare(
    `INSERT INTO chat_settings (chat_jid, proactive, muted_until, last_unsolicited_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_jid) DO UPDATE SET
       proactive = excluded.proactive,
       muted_until = excluded.muted_until,
       last_unsolicited_at = excluded.last_unsolicited_at`
  ).run(chatJid, next.proactive, next.muted_until, next.last_unsolicited_at);
}

/**
 * "Conversation continuation" check: the bot replied in this chat moments
 * ago, and this sender was part of the exchange leading up to that reply —
 * so their follow-up is almost certainly addressed to the bot even without
 * the trigger word ("howw?" right after the bot offered something).
 * Participation is bounded to BEFORE the bot's reply so a bystander jumping
 * in right after doesn't count.
 */
export function isRecentExchange(chatJid, senderNumber, { replyWindowMs = 120_000, participationWindowMs = 300_000 } = {}) {
  const lastBot = db
    .prepare(`SELECT created_at FROM messages WHERE chat_jid = ? AND is_from_me = 1 ORDER BY created_at DESC LIMIT 1`)
    .get(chatJid);
  if (!lastBot || Date.now() - lastBot.created_at > replyWindowMs) return false;
  return !!db
    .prepare(
      `SELECT 1 FROM messages WHERE chat_jid = ? AND sender_number = ? AND is_from_me = 0
       AND created_at BETWEEN ? AND ? LIMIT 1`
    )
    .get(chatJid, senderNumber, lastBot.created_at - participationWindowMs, lastBot.created_at);
}

export function saveGoogleAuth({ email, refreshToken, accessToken, expiryDate }) {
  db.prepare(
    `INSERT INTO google_auth (id, email, refresh_token, access_token, expiry_date, updated_at) VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       refresh_token = excluded.refresh_token,
       access_token = excluded.access_token,
       expiry_date = excluded.expiry_date,
       updated_at = excluded.updated_at`
  ).run(email ?? null, refreshToken, accessToken ?? null, expiryDate ?? null, Date.now());
}

// Access tokens are short-lived and refreshed automatically by the OAuth
// client — only persist them opportunistically so we don't always start
// from a cold refresh on process restart.
export function updateGoogleAccessToken(accessToken, expiryDate) {
  db.prepare(`UPDATE google_auth SET access_token = ?, expiry_date = ?, updated_at = ? WHERE id = 1`).run(
    accessToken,
    expiryDate ?? null,
    Date.now()
  );
}

export function getGoogleAuth() {
  return db.prepare(`SELECT * FROM google_auth WHERE id = 1`).get() ?? null;
}

export function clearGoogleAuth() {
  db.prepare(`DELETE FROM google_auth WHERE id = 1`).run();
}
