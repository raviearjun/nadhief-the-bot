# John — Deployment Notes

Personal, single-owner WhatsApp assistant ("John"). This repo is developed in
this sandbox (`/var/www/daytona-test/john-the-bot`) but **runs in production
on a separate VPS**, not in this sandbox and not on Daytona. Anything about
"Daytona sandbox" hosting for this bot is obsolete — ignore `deploy_wabot.py`
/ `.wabot_sandbox_id` if you find references to them.

## Where it runs

- VPS SSH alias: `balesoftware` (103.150.197.170, user `revaldyas`, port 22).
  Connect from a dev machine with `ssh balesoftware` if that alias is
  configured locally; otherwise `ssh revaldyas@103.150.197.170`.
- `revaldyas` has passwordless (NOPASSWD) full `sudo` on this VPS.
- Working directory on the VPS: `~/wabot` (i.e. `/home/revaldyas/wabot`).
  **The directory name is `wabot`, not `john-the-bot`** — it predates the
  GitHub repo being renamed to `john-the-bot`. Don't be thrown by the
  mismatch; it's the same deployment.
- Node version on the VPS: v22.23.1. No build step — runs directly via `tsx`
  (`node --import tsx src/index.ts`), same as this sandbox.

## Repo / git

- GitHub: `revaldyas/john-the-bot` (private).
- The VPS clones/pulls via a dedicated **read-only deploy key**, not your
  personal push credentials: SSH config on the VPS (`~/.ssh/config`) has

  ```
  Host github-john-the-bot
    HostName github.com
    User git
    IdentityFile ~/.ssh/john_the_bot_pull_key
    IdentitiesOnly yes
  ```

  and `~/wabot`'s git remote is
  `github-john-the-bot:revaldyas/john-the-bot.git`. This key can only pull,
  not push — deliberate, so a compromised VPS can't push malicious commits
  back to the repo.

## Systemd service

Unit file: `/etc/systemd/system/wabot.service`

```ini
[Unit]
Description=WA Bot (John) - personal WhatsApp assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=revaldyas
WorkingDirectory=/home/revaldyas/wabot
ExecStart=/usr/bin/node --import tsx /home/revaldyas/wabot/src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Env vars are loaded by `dotenv/config` from `~/wabot/.env` inside the Node
process itself (no `EnvironmentFile=` in the unit — different from the
platform, see its own DEPLOYMENT.md).

Useful commands: `sudo systemctl status wabot`, `sudo systemctl restart
wabot`, `sudo journalctl -u wabot -n 100 --no-pager` (or `-f` to follow).

## Deploy procedure

Canonical deploy script, already on the VPS at `~/bin/deploy-john-the-bot.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd ~/wabot
git fetch origin main
git reset --hard origin/main
npm ci --omit=dev
sudo systemctl restart wabot
echo "deployed $(git rev-parse --short HEAD)"
```

To deploy from a dev machine after pushing to `main`:

```bash
ssh balesoftware "~/bin/deploy-john-the-bot.sh"
```

`tsx` must stay a `dependency` (not `devDependency`) in `package.json` — the
deploy script runs `npm ci --omit=dev`, and if `tsx` were a devDependency it
simply wouldn't get installed and the service would fail to start.

## Environment variables (names only — never commit or paste actual values)

From `~/wabot/.env` on the VPS:

```
LLM_BASE_URL, LLM_API_KEY, LLM_MODEL, LLM_REASONING_EFFORT, LLM_VISION_MODEL
TAVILY_API_KEY, YOUTUBE_API_KEY, GITHUB_TOKEN
OWNER_NUMBER, BOT_TRIGGER_NAME
REMINDER_HOUR, REMINDER_MINUTE
ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET
PORT, HOST
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
IGNORE_NUMBERS
BUILDER_CLAUDE_OAUTH_TOKEN
```

`.env` on the VPS is separate from anything in this sandbox and is never
committed. If you need a value, ask the owner to check/set it directly on
the VPS — never have it pasted into a chat session (see Security section).

## Data & session persistence

- WhatsApp session credentials (Baileys `auth_info/` or similar) and the
  bot's SQLite database live only on the VPS, under `~/wabot`. Never
  overwrite or delete these when deploying — the deploy script only touches
  source/`node_modules`, not data.
- On process boot, John reconnects using whatever WhatsApp session is
  persisted on disk. If the VPS's `auth_info` is ever wiped, the bot needs a
  fresh QR pairing.

## Dashboard

- Binds to `127.0.0.1:<PORT>` (currently 3000) — not exposed directly.
- Publicly reachable via nginx + Let's Encrypt at
  **https://revabot.balesoftware.web.id** (see
  `/etc/nginx/sites-available/revabot`, proxies to `127.0.0.1:3000`).
- Still reachable the "old" way too if nginx is ever down: SSH tunnel with
  `ssh -L 3000:localhost:3000 balesoftware`, then open `localhost:3000`.

## Claude Code integration (added 2026-07-20)

John can now delegate real coding/ops work to the `claude` CLI in two
separate, differently-trusted ways:

### 1. `run_claude_code` skill (`src/skills/code.ts`)

General-purpose: lets the owner ask John to run an arbitrary headless Claude
Code task anywhere on the VPS. Same trust model as the pre-existing
`run_shell_command` skill (`src/skills/shell.ts`): **owner-only, DM-only,
staged + explicit deterministic confirmation** — the LLM only stages a task;
it's executed only after the owner's own next message passes
`isConfirmation()` in code (never a model self-confirmation). Runs `claude -p
<task> --output-format text --dangerously-skip-permissions` in the given
directory (default: `revaldyas`'s home) and reports back async since it can
take minutes.

Auth: uses the systemwide `claude` CLI installed at `/usr/bin/claude`
(`npm install -g @anthropic-ai/claude-code`), logged in as the `revaldyas`
Linux user via `claude setup-token` against the owner's own Claude.ai Pro
subscription. That login **does** retain a working OAuth refresh token, so
it keeps itself authenticated indefinitely with no extra env var needed by
this skill.

### 2. `build_app` / `list_apps` / `app_status` skills (`src/skills/webapp.ts` + `src/builder.ts`)

Pre-existing, more isolated integration for building/hosting actual web
apps for the owner. Runs Claude Code as a **separate, unprivileged Linux
user** `johnbuilder` (uid 1002, no sudo) via `sudo -u johnbuilder -H`, using
a standalone binary at `/opt/claude-code/claude` (not the npm-global one),
confined to `/home/johnbuilder/projects/<slug>`. Built apps are served on
ports 5100–5199 and exposed at `http://103.150.197.170:<port>` (no nginx/TLS
for these — they're throwaway/dev previews, not the main dashboard).

**Known gotcha (already hit once, fixed 2026-07-20):** `johnbuilder`'s own
Claude Code credential store (`/home/johnbuilder/.claude/.credentials.json`)
does **not** retain a working refresh token, unlike `revaldyas`'s — running
`claude setup-token` as `johnbuilder` prints a fresh long-lived token but
does not persist it into a usable session. So `builder.ts` passes the token
**explicitly** on every invocation via `env CLAUDE_CODE_OAUTH_TOKEN=... `
(see `withBuilderEnv()` in `builder.ts`), reading it from
`BUILDER_CLAUDE_OAUTH_TOKEN` in `~/wabot/.env`. If `build_app` starts
failing with a 401 again, this token has likely expired (1-year validity)
and needs regenerating:

```bash
sudo -u johnbuilder -H script -qc '/opt/claude-code/claude setup-token' /tmp/x.txt
# complete the browser OAuth flow, paste the code back into the terminal,
# copy the final printed sk-ant-oat01-... token, then:
rm -f /tmp/x.txt   # (may need `sudo rm -f`, since the transcript is owned by johnbuilder)
```

Then update `BUILDER_CLAUDE_OAUTH_TOKEN` in `~/wabot/.env` and `sudo
systemctl restart wabot`. `webapp.ts`'s skills disable themselves entirely
if `BUILDER_CLAUDE_OAUTH_TOKEN` is unset.

## Known gotchas

- VPS directory is `~/wabot`, GitHub repo is `john-the-bot` — not a typo.
- `revaldyas` has full NOPASSWD sudo. The `run_shell_command` and
  `run_claude_code` skills are effectively root-equivalent for the owner —
  that's intentional but means their owner-only/DM-only/staged-confirmation
  gating is the *entire* safety boundary. Don't weaken it casually.
- `johnbuilder` is deliberately unprivileged and confined to its own home —
  keep it that way; don't add it to sudoers or widen its filesystem access.

## Security

- **Never paste API keys, tokens, or other secrets into a chat session
  (including this one) or commit them to git.** If a secret is ever pasted
  into chat, treat it as burned immediately and rotate/revoke it — chat
  transcripts are not a secure secret store. When a credential needs to be
  set, have it entered directly into the target file on the VPS (over SSH,
  in an editor, or via a short script that reads an env var/file and never
  echoes the value) — never relayed through a chat message.
