import { google } from "googleapis";
import { getAuthorizedClient, isGoogleConnected } from "../google.js";

function calendarClient() {
  return google.calendar({ version: "v3", auth: getAuthorizedClient() });
}

function parseIso(label, value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ${label}, use ISO 8601 e.g. 2026-07-25T14:00:00+07:00`);
  return d;
}

// Attach the server's IANA timezone (the VPS runs in the owner's local time)
// so events carry an explicit zone instead of a bare UTC instant.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function skills() {
  if (!isGoogleConnected()) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "create_calendar_event",
          description:
            "Create an event on the connected Google Calendar. Use when asked to schedule/jadwalkan " +
            "something with a specific date/time ('jadwalin meeting besok jam 2').",
          parameters: {
            type: "object",
            properties: {
              summary: { type: "string", description: "Event title" },
              start: { type: "string", description: "Start time, ISO 8601 with timezone offset, e.g. 2026-07-25T14:00:00+07:00" },
              end: { type: "string", description: "End time, ISO 8601. Defaults to 1 hour after start if omitted." },
              description: { type: "string" },
              location: { type: "string" },
            },
            required: ["summary", "start"],
          },
        },
      },
      execute: async ({ summary, start, end, description, location }) => {
        try {
          const startDate = parseIso("start", start);
          const endDate = end ? parseIso("end", end) : new Date(startDate.getTime() + 60 * 60 * 1000);
          const res = await calendarClient().events.insert({
            calendarId: "primary",
            requestBody: {
              summary,
              description,
              location,
              start: { dateTime: startDate.toISOString(), timeZone: TZ },
              end: { dateTime: endDate.toISOString(), timeZone: TZ },
            },
          });
          return { ok: true, event_id: res.data.id, link: res.data.htmlLink };
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_calendar_events",
          description: "List upcoming events on the connected Google Calendar within a time range.",
          parameters: {
            type: "object",
            properties: {
              time_min: { type: "string", description: "Start of range, ISO 8601. Defaults to now." },
              time_max: { type: "string", description: "End of range, ISO 8601. Defaults to 7 days after time_min." },
              max_results: { type: "number", description: "Max events to return, default 10" },
            },
          },
        },
      },
      execute: async ({ time_min, time_max, max_results }) => {
        try {
          const timeMin = time_min ? parseIso("time_min", time_min) : new Date();
          const timeMax = time_max ? parseIso("time_max", time_max) : new Date(timeMin.getTime() + 7 * 24 * 60 * 60 * 1000);
          const res = await calendarClient().events.list({
            calendarId: "primary",
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            maxResults: Math.min(Math.max(Number(max_results) || 10, 1), 50),
            singleEvents: true,
            orderBy: "startTime",
          });
          return {
            events: (res.data.items ?? []).map((e) => ({
              id: e.id,
              summary: e.summary,
              start: e.start?.dateTime || e.start?.date,
              end: e.end?.dateTime || e.end?.date,
              location: e.location ?? null,
            })),
          };
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "update_calendar_event",
          description: "Update an existing calendar event. Use list_calendar_events first to find the event id.",
          parameters: {
            type: "object",
            properties: {
              event_id: { type: "string" },
              summary: { type: "string" },
              start: { type: "string", description: "ISO 8601" },
              end: { type: "string", description: "ISO 8601" },
              description: { type: "string" },
              location: { type: "string" },
            },
            required: ["event_id"],
          },
        },
      },
      execute: async ({ event_id, summary, start, end, description, location }) => {
        try {
          const requestBody: any = {};
          if (summary) requestBody.summary = summary;
          if (description) requestBody.description = description;
          if (location) requestBody.location = location;
          if (start) requestBody.start = { dateTime: parseIso("start", start).toISOString(), timeZone: TZ };
          if (end) requestBody.end = { dateTime: parseIso("end", end).toISOString(), timeZone: TZ };
          const res = await calendarClient().events.patch({ calendarId: "primary", eventId: event_id, requestBody });
          return { ok: true, event_id: res.data.id };
        } catch (err) {
          return { error: err.message };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "delete_calendar_event",
          description: "Delete a calendar event by id. Use list_calendar_events first to find the id.",
          parameters: {
            type: "object",
            properties: { event_id: { type: "string" } },
            required: ["event_id"],
          },
        },
      },
      execute: async ({ event_id }) => {
        try {
          await calendarClient().events.delete({ calendarId: "primary", eventId: event_id });
          return { ok: true };
        } catch (err) {
          return { error: err.message };
        }
      },
    },
  ];
}
