import { addTodo, listTodos, setTodoDone, removeTodo } from "../db.js";

// Todos belong to the person (phone number), not the chat — the same list is
// reachable from a DM and from any group they speak in.
export function skills(ctx) {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "manage_todos",
          description:
            "Manage the personal todo list of the person you're talking to. " +
            "Actions: add (needs text), list, done (needs id), remove (needs id). " +
            "Use when they mention tasks to track, ask what's on their list, or finish something.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "list", "done", "remove"] },
              text: { type: "string", description: "Todo text (for add)" },
              id: { type: "number", description: "Todo id (for done/remove; get it from list)" },
            },
            required: ["action"],
          },
        },
      },
      execute: ({ action, text, id }) => {
        const person = ctx.senderNumber;
        switch (action) {
          case "add": {
            if (!text) return { error: "text is required for add" };
            const newId = addTodo(person, text);
            return { ok: true, id: newId };
          }
          case "list":
            return { todos: listTodos(person).map((t) => ({ id: t.id, text: t.text })) };
          case "done":
            return setTodoDone(Number(id), person) ? { ok: true } : { error: "no open todo with that id" };
          case "remove":
            return removeTodo(Number(id), person) ? { ok: true } : { error: "no todo with that id" };
          default:
            return { error: "unknown action" };
        }
      },
    },
  ];
}
