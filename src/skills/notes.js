import { addNote, getNotesForChats, deleteNote } from "../db.js";

export function skills(ctx) {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "save_note",
          description:
            "Explicitly save a note/important info for this chat (schedules, agreements, links, addresses). " +
            "Use when the user says things like 'catat...', 'simpan ini', 'note this'.",
          parameters: {
            type: "object",
            properties: { content: { type: "string", description: "The note content, short and self-contained" } },
            required: ["content"],
          },
        },
      },
      execute: ({ content }) => {
        if (!content) return { error: "content is required" };
        addNote(ctx.chatJid, content, "note");
        return { ok: true };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_notes",
          description:
            "List saved notes/links relevant to this conversation (this chat plus groups this person is in), " +
            "with ids needed to delete one.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: () => ({
        notes: getNotesForChats(ctx.relevantChatJids, 30).map((n) => ({ id: n.id, kind: n.kind, content: n.content })),
      }),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "delete_note",
          description: "Delete a saved note by id (use list_notes first to find the id). Only works for notes of the current chat.",
          parameters: {
            type: "object",
            properties: { id: { type: "number", description: "Note id" } },
            required: ["id"],
          },
        },
      },
      execute: ({ id }) => (deleteNote(Number(id), ctx.chatJid) ? { ok: true } : { error: "no note with that id in this chat" }),
    },
  ];
}
