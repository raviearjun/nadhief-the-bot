/**
 * Skill registry. Each skill module exports skills(ctx) -> array of
 * { definition, execute } where definition is an OpenAI-style tool spec and
 * execute(args) returns a JSON-serializable result for the LLM. Modules
 * return [] when they don't apply to the current context (e.g. group-only
 * skills in a DM, search without an API key).
 *
 * ctx: { chatJid, senderNumber, senderName, isGroup, relevantChatJids, sock }
 */
import * as search from "./search.js";
import * as calculator from "./calculator.js";
import * as weather from "./weather.js";
import * as prayer from "./prayer.js";
import * as currency from "./currency.js";
import * as reminders from "./reminders.js";
import * as todos from "./todos.js";
import * as notes from "./notes.js";
import * as summary from "./summary.js";
import * as group from "./group.js";
import * as calendar from "./calendar.js";
import * as docs from "./docs.js";
import * as drive from "./drive.js";
import * as bioskop from "./bioskop.js";
import * as whitelist from "./whitelist.js";
import * as gmail from "./gmail.js";
import * as sheets from "./sheets.js";
import * as youtube from "./youtube.js";
import * as github from "./github.js";
import * as music from "./music.js";
import * as server from "./server.js";
import * as sticker from "./sticker.js";
import * as shell from "./shell.js";
import * as webapp from "./webapp.js";
import * as code from "./code.js";
import * as generate from "./generate.js";
import * as exa from "./exa.js";
import * as sandbox from "./sandbox.js";
import * as webappDaytona from "./webapp_daytona.js";

const MODULES: any[] = [search, calculator, weather, prayer, currency, reminders, todos, notes, summary, group, calendar, docs, drive, bioskop, whitelist, gmail, sheets, youtube, github, music, server, sticker, shell, webapp, code, generate, exa, sandbox, webappDaytona];

export function buildSkills(ctx) {
  return MODULES.flatMap((m) => m.skills(ctx));
}
