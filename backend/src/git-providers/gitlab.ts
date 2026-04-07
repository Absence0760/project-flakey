import type { GitProvider, GitProviderConfig } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";

export function createGitLabProvider(config: GitProviderConfig): GitProvider {
  const baseUrl = (config.baseUrl ?? "https://gitlab.com").replace(/\/+$/, "");
  const projectId = encodeURIComponent(config.repo);

  async function api(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/v4${path}`, {
      ...options,
      headers: {
        "PRIVATE-TOKEN": config.token,
        ...options.headers,
      },
    });
  }

  return {
    async findPRByCommit(commitSha) {
      const res = await api(`/projects/${projectId}/repository/commits/${commitSha}/merge_requests`);
      if (!res.ok) return null;
      const mrs = await res.json() as Array<{ iid: number; state: string }>;
      const open = mrs.find((m) => m.state === "opened");
      return open?.iid ?? mrs[0]?.iid ?? null;
    },

    async findPRByBranch(branch) {
      const res = await api(`/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=opened`);
      if (!res.ok) return null;
      const mrs = await res.json() as Array<{ iid: number }>;
      return mrs[0]?.iid ?? null;
    },

    async findExistingComment(mrIid) {
      const res = await api(`/projects/${projectId}/merge_requests/${mrIid}/notes?per_page=100`);
      if (!res.ok) return null;
      const notes = await res.json() as Array<{ id: number; body: string }>;
      const existing = notes.find((n) => n.body.includes(COMMENT_MARKER));
      return existing?.id ?? null;
    },

    async createComment(mrIid, body) {
      await api(`/projects/${projectId}/merge_requests/${mrIid}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },

    async updateComment(mrIid, noteId, body) {
      await api(`/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },
  };
}
