import { config } from "../config.js";

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_FILE_CHARS = 6000;

async function gh(path, opts: any = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "wabot-john",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as any;
}

// "wabot" -> "reva/wabot" using the token owner's login; "org/repo" passes through.
let cachedLogin = null;
async function fullRepo(repo) {
  if (repo.includes("/")) return repo;
  if (!cachedLogin) cachedLogin = (await gh("/user")).login;
  return `${cachedLogin}/${repo}`;
}

async function listRepos() {
  const repos = await gh("/user/repos?sort=pushed&per_page=15");
  return {
    repos: repos.map((r) => ({
      name: r.full_name,
      private: r.private,
      last_push: r.pushed_at?.slice(0, 10),
      open_issues: r.open_issues_count,
      description: r.description,
    })),
  };
}

async function repoActivity(repo, branch) {
  const full = await fullRepo(repo);
  const shaParam = branch ? `&sha=${encodeURIComponent(branch)}` : "";
  const [commits, pulls, issues] = await Promise.all([
    gh(`/repos/${full}/commits?per_page=8${shaParam}`),
    gh(`/repos/${full}/pulls?state=open&per_page=10`),
    gh(`/repos/${full}/issues?state=open&per_page=10`),
  ]);
  return {
    repo: full,
    branch: branch ?? "(default)",
    recent_commits: commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author?.name,
      date: c.commit.author?.date?.slice(0, 10),
    })),
    open_prs: pulls.map((p) => ({ number: p.number, title: p.title, author: p.user?.login, url: p.html_url })),
    // /issues also returns PRs — keep the real issues only
    open_issues: issues
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, author: i.user?.login, url: i.html_url })),
  };
}

async function readFile(repo, path, ref) {
  const full = await fullRepo(repo);
  const data = await gh(`/repos/${full}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`);
  if (Array.isArray(data)) {
    return { repo: full, path, directory: data.map((f) => `${f.type === "dir" ? "📁" : "📄"} ${f.name}`) };
  }
  const content = Buffer.from(data.content ?? "", "base64").toString("utf8");
  const truncated = content.length > MAX_FILE_CHARS;
  return {
    repo: full,
    path,
    content: truncated ? content.slice(0, MAX_FILE_CHARS) + "\n[...dipotong]" : content,
    url: data.html_url,
  };
}

async function listBranches(repo) {
  const full = await fullRepo(repo);
  const branches = await gh(`/repos/${full}/branches?per_page=50`);
  return { repo: full, branches: branches.map((b) => b.name) };
}

async function compareBranches(repo, base, head) {
  const full = await fullRepo(repo);
  const cmp = await gh(`/repos/${full}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  return {
    repo: full,
    base,
    head,
    status: cmp.status, // ahead | behind | diverged | identical
    ahead_by: cmp.ahead_by,
    behind_by: cmp.behind_by,
    commits: (cmp.commits ?? []).slice(-10).map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author?.name,
      date: c.commit.author?.date?.slice(0, 10),
    })),
    files_changed: (cmp.files ?? []).slice(0, 30).map((f) => ({
      file: f.filename,
      status: f.status,
      changes: `+${f.additions}/-${f.deletions}`,
    })),
    url: cmp.html_url,
  };
}

async function createIssue(repo, title, body) {
  const full = await fullRepo(repo);
  const issue = await gh(`/repos/${full}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, body: body || "" }),
  });
  return { ok: true, number: issue.number, url: issue.html_url };
}

export function skills() {
  if (!config.githubToken) return [];

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "list_github_repos",
          description: "List the user's GitHub repositories, most recently pushed first.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: () => listRepos().catch((err) => ({ error: err.message })),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "get_repo_activity",
          description:
            "Get a repo's recent commits, open pull requests, and open issues. " +
            "Use for 'ada PR baru gak di repo X?', 'commit terakhir apa?', 'issue apa yang masih open?'. " +
            "Pass branch to see commits of a non-default branch.",
          parameters: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repo name ('wabot') or full name ('owner/wabot')" },
              branch: { type: "string", description: "Optional branch name; default = default branch" },
            },
            required: ["repo"],
          },
        },
      },
      execute: ({ repo, branch }) => repoActivity(repo, branch).catch((err) => ({ error: err.message })),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_branches",
          description: "List all branches of a GitHub repo.",
          parameters: {
            type: "object",
            properties: { repo: { type: "string", description: "Repo name or owner/repo" } },
            required: ["repo"],
          },
        },
      },
      execute: ({ repo }) => listBranches(repo).catch((err) => ({ error: err.message })),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "compare_branches",
          description:
            "Compare two branches of a repo: how far ahead/behind, the commits in between, and which files " +
            "changed. Use for 'branch X udah beda apa aja dari trunk/main?'.",
          parameters: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repo name or owner/repo" },
              base: { type: "string", description: "Base branch, e.g. 'main' or 'trunk'" },
              head: { type: "string", description: "Branch to compare against base, e.g. 'data-remap'" },
            },
            required: ["repo", "base", "head"],
          },
        },
      },
      execute: ({ repo, base, head }) => compareBranches(repo, base, head).catch((err) => ({ error: err.message })),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_github_file",
          description:
            "Read a file (or list a directory) from a GitHub repo. " +
            "Use for 'isi file X di repo Y apa?', 'struktur folder src gimana?'.",
          parameters: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repo name or owner/repo" },
              path: { type: "string", description: "File or directory path, e.g. 'src/index.js' or ''" },
              ref: { type: "string", description: "Optional branch/tag/sha; default = default branch" },
            },
            required: ["repo", "path"],
          },
        },
      },
      execute: ({ repo, path, ref }) => readFile(repo, path, ref).catch((err) => ({ error: err.message })),
    },
    {
      definition: {
        type: "function",
        function: {
          name: "create_github_issue",
          description:
            "Create an issue in a GitHub repo — great for logging bugs/ideas/tasks from chat so they can be " +
            "picked up later from a laptop. IMPORTANT: show the user the draft title+body and get their " +
            "confirmation before calling this.",
          parameters: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repo name or owner/repo" },
              title: { type: "string" },
              body: { type: "string", description: "Issue body in markdown; include reproduction steps/details" },
            },
            required: ["repo", "title"],
          },
        },
      },
      execute: ({ repo, title, body }) => createIssue(repo, title, body).catch((err) => ({ error: err.message })),
    },
  ];
}
