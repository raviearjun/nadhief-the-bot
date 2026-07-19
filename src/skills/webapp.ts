import { startBuild, listProjects, getProject } from "../builder.js";

/**
 * Web-app builder tools — owner + DM only, same reasoning as the shell skill:
 * this spends real money (Claude Code tokens) and produces publicly-served
 * apps, so it must never be triggerable by group members or via injected
 * content. The heavy lifting and isolation live in ../builder.js.
 */
export function skills(ctx) {
  if (!ctx.isOwner || ctx.isGroup) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "build_app",
          description:
            "Build (or iterate on) a real web app/website for the owner. A dedicated coding agent does the " +
            "work asynchronously in an isolated workspace and the owner is messaged with a live link when it's " +
            "done — so after calling this, just tell them it's being worked on and you'll send the link when " +
            "ready. Use for 'bikinin website/app ...' and for follow-up changes ('tambahin fitur X ke app Y'). " +
            "For a change to an existing app, pass its same project_name and set iterate=true.",
          parameters: {
            type: "object",
            properties: {
              project_name: {
                type: "string",
                description: "Short name for the project (reused across iterations, e.g. 'toko-kopi')",
              },
              description: {
                type: "string",
                description:
                  "Full, detailed description of what to build or change — include everything the owner asked " +
                  "for (features, pages, style, data). The coding agent only sees this text.",
              },
              iterate: {
                type: "boolean",
                description: "true = modify the existing project_name instead of building fresh",
              },
            },
            required: ["project_name", "description"],
          },
        },
      },
      execute: async ({ project_name, description, iterate }) => {
        if (!description?.trim()) return { error: "deskripsi kosong — minta owner jelasin mau bikin apa" };
        const res = await startBuild({
          projectName: project_name,
          description,
          chatJid: ctx.chatJid,
          isIteration: Boolean(iterate),
        });
        if (res.error) return res;
        return {
          started: true,
          slug: res.slug,
          note: `Build "${res.slug}" jalan di background (beberapa menit). Kabari owner kamu lagi ngerjain dan bakal kirim link kalau udah jadi — JANGAN mengarang link sekarang.`,
        };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_apps",
          description: "List the web apps/projects built for the owner, with their status and live links.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: () => {
        const list = listProjects();
        return list.length ? { projects: list } : { note: "belum ada app yang dibangun" };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "app_status",
          description: "Check the status and live link of one built app by its project name.",
          parameters: {
            type: "object",
            properties: { project_name: { type: "string" } },
            required: ["project_name"],
          },
        },
      },
      execute: ({ project_name }) => getProject(project_name) ?? { error: "proyek tidak ditemukan" },
    },
  ];
}
