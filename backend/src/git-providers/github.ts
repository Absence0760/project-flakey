import type { GitProvider, GitProviderConfig } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";

export function createGitHubProvider(config: GitProviderConfig): GitProvider {
  const [owner, repo] = config.repo.split("/");
  const baseUrl = config.baseUrl ?? "https://api.github.com";

  async function api(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
  }

  return {
    async findPRByCommit(commitSha) {
      const res = await api(`/repos/${owner}/${repo}/commits/${commitSha}/pulls`);
      if (!res.ok) return null;
      const pulls = await res.json() as Array<{ number: number; state: string }>;
      const open = pulls.find((p) => p.state === "open");
      return open?.number ?? pulls[0]?.number ?? null;
    },

    async findPRByBranch(branch) {
      const res = await api(`/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`);
      if (!res.ok) return null;
      const pulls = await res.json() as Array<{ number: number }>;
      return pulls[0]?.number ?? null;
    },

    async findExistingComment(prId) {
      const res = await api(`/repos/${owner}/${repo}/issues/${prId}/comments?per_page=100`);
      if (!res.ok) return null;
      const comments = await res.json() as Array<{ id: number; body: string }>;
      const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
      return existing?.id ?? null;
    },

    async createComment(prId, body) {
      await api(`/repos/${owner}/${repo}/issues/${prId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },

    async updateComment(_prId, commentId, body) {
      await api(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },
  };
}
