import express from "express";
import session from "express-session";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { waState } from "../whatsapp/connection.js";
import { getUsageStats, listWhitelist, addToWhitelist, removeFromWhitelist, listContacts, getGoogleAuth, db } from "../db.js";
import { isGoogleConfigured, isGoogleConnected, getAuthUrl, handleOAuthCallback, disconnectGoogle } from "../google.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPasswordHash = bcrypt.hashSync(config.adminPassword, 10);

export function createDashboardApp() {
  const app = express();
  app.use(express.json());

  // Runs behind nginx (HTTPS) on the public subdomain — trust its
  // X-Forwarded-* headers so req.secure/req.ip are the real values, and let
  // the session cookie be Secure on HTTPS while still working over the
  // localhost tunnel ("auto").
  app.set("trust proxy", 1);

  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { maxAge: 12 * 60 * 60 * 1000, secure: "auto", sameSite: "lax" },
    })
  );

  // The dashboard is exposed to the public internet — throttle login
  // brute-forcing. In-memory is fine: a restart resetting counters is
  // acceptable, and there's only one legitimate user.
  const loginFails = new Map(); // ip -> { count, firstAt }
  const MAX_FAILS = 10;
  const FAIL_WINDOW_MS = 15 * 60 * 1000;

  function loginThrottled(ip) {
    const entry = loginFails.get(ip);
    if (!entry || Date.now() - entry.firstAt > FAIL_WINDOW_MS) return false;
    return entry.count >= MAX_FAILS;
  }

  function recordLoginFail(ip) {
    const entry = loginFails.get(ip);
    if (!entry || Date.now() - entry.firstAt > FAIL_WINDOW_MS) {
      loginFails.set(ip, { count: 1, firstAt: Date.now() });
    } else {
      entry.count += 1;
    }
  }

  function requireAuth(req, res, next) {
    if (req.session.authed) return next();
    res.status(401).json({ error: "unauthorized" });
  }

  app.post("/api/login", (req, res) => {
    if (loginThrottled(req.ip)) {
      return res.status(429).json({ error: "too many attempts, try again in 15 minutes" });
    }
    const { username, password } = req.body || {};
    if (username === config.adminUsername && bcrypt.compareSync(password || "", adminPasswordHash)) {
      loginFails.delete(req.ip);
      req.session.authed = true;
      return res.json({ ok: true });
    }
    recordLoginFail(req.ip);
    res.status(401).json({ error: "invalid credentials" });
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get("/api/me", (req, res) => {
    res.json({ authed: !!req.session.authed });
  });

  app.get("/api/status", requireAuth, (req, res) => {
    res.json({ status: waState.status, qrDataUrl: waState.qrDataUrl, ownJid: waState.ownJid });
  });

  app.get("/api/usage", requireAuth, (req, res) => {
    res.json(getUsageStats());
  });

  app.get("/api/whitelist", requireAuth, (req, res) => {
    res.json(listWhitelist());
  });

  app.post("/api/whitelist", requireAuth, (req, res) => {
    const { number, label } = req.body || {};
    if (!number) return res.status(400).json({ error: "number required" });
    addToWhitelist(String(number).replace(/\D/g, ""), label || "");
    res.json({ ok: true });
  });

  app.delete("/api/whitelist/:number", requireAuth, (req, res) => {
    removeFromWhitelist(req.params.number);
    res.json({ ok: true });
  });

  app.get("/api/chats", requireAuth, (req, res) => {
    const chats = db
      .prepare(
        `SELECT chat_jid, chat_name, COUNT(*) as message_count, MAX(created_at) as last_at
         FROM messages GROUP BY chat_jid ORDER BY last_at DESC LIMIT 100`
      )
      .all();
    res.json(chats);
  });

  app.get("/api/messages", requireAuth, (req, res) => {
    const chatJid = req.query.chat;
    if (!chatJid) return res.status(400).json({ error: "chat query param required" });
    const rows = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ? ORDER BY created_at DESC LIMIT 200`)
      .all(chatJid);
    res.json(rows);
  });

  app.get("/api/notes", requireAuth, (req, res) => {
    const chatJid = req.query.chat;
    const rows = chatJid
      ? db.prepare(`SELECT * FROM notes WHERE chat_jid = ? ORDER BY created_at DESC LIMIT 200`).all(chatJid)
      : db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT 200`).all();
    res.json(rows);
  });

  app.delete("/api/notes/:id", requireAuth, (req, res) => {
    db.prepare(`DELETE FROM notes WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: true });
  });

  app.get("/api/contacts", requireAuth, (req, res) => {
    res.json(listContacts());
  });

  app.get("/api/facts", requireAuth, (req, res) => {
    const person = req.query.person;
    const rows = person
      ? db.prepare(`SELECT * FROM facts WHERE person_number = ? ORDER BY key`).all(person)
      : db.prepare(`SELECT * FROM facts ORDER BY person_number, key`).all();
    res.json(rows);
  });

  app.delete("/api/facts/:personNumber/:key", requireAuth, (req, res) => {
    db.prepare(`DELETE FROM facts WHERE person_number = ? AND key = ?`).run(req.params.personNumber, req.params.key);
    res.json({ ok: true });
  });

  app.get("/api/google/status", requireAuth, (req, res) => {
    res.json({
      configured: isGoogleConfigured(),
      connected: isGoogleConnected(),
      email: getGoogleAuth()?.email ?? null,
    });
  });

  app.get("/api/google/auth-url", requireAuth, (req, res) => {
    if (!isGoogleConfigured()) return res.status(400).json({ error: "GOOGLE_CLIENT_ID/SECRET not set" });
    res.json({ url: getAuthUrl() });
  });

  // Google redirects the admin's own browser here after consent — same
  // session cookie carries over since it's a same-origin navigation.
  app.get("/api/google/callback", requireAuth, async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Google OAuth error: ${error}`);
    if (!code) return res.status(400).send("Missing code");
    try {
      const email = await handleOAuthCallback(String(code));
      res.send(
        `<p>Google Calendar terhubung sebagai <b>${email}</b>. Tab ini boleh ditutup, kembali ke dashboard.</p>`
      );
    } catch (err) {
      res.status(500).send(`Gagal connect: ${err.message}`);
    }
  });

  app.post("/api/google/disconnect", requireAuth, (req, res) => {
    disconnectGoogle();
    res.json({ ok: true });
  });

  app.use(express.static(path.join(__dirname, "public")));

  return app;
}
