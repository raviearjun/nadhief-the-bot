import { config } from "./config.js";
import "./db.js"; // initializes schema on import
import { addToWhitelist } from "./db.js";
import { startWhatsApp, getSocket, waState } from "./whatsapp/connection.js";
import { createMessageHandler } from "./whatsapp/handler.js";
import { startDailyReminder, startReminderChecker, startGroupSummaries } from "./scheduler.js";
import { createDashboardApp } from "./dashboard/server.js";

// owner is always allowed to talk to their own bot
addToWhitelist(config.ownerNumber, "owner");

const app = createDashboardApp();
app.listen(config.port, config.host, () => {
  console.log(`[dashboard] listening on ${config.host}:${config.port}`);
});

const onMessage = createMessageHandler({ waState });
await startWhatsApp(onMessage);

startDailyReminder(getSocket);
startReminderChecker(getSocket);
startGroupSummaries(getSocket);
