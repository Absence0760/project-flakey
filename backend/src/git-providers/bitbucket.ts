import type { GitProvider, GitProviderConfig } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";

export function createBitbucketProvider(config: GitProviderConfig): GitProvider {
  const baseUrl = (config.baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
  const repoPath = config.repo; // workspace/repo-slug

  async function api(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...options.headers,
      },
    });
  }

  return {
    async findPRByCommit(commitSha) {
      const res = await api(`/repositories/${repoPath}/commit/${commitSha}/pullrequests`);
      if (!res.ok) return null;
      const data = await res.json() as { values: Array<{ id: number; state: string }> };
      const open = data.values?.find((p) => p.state === "OPEN");
      return open?.id ?? data.values?.[0]?.id ?? null;
    },

    async findPRByBranch(branch) {
      const q = encodeURIComponent(`source.branch.name="${branch}" AND state="OPEN"`);
      const res = await api(`/repositories/${repoPath}/pullrequests?q=${q}`);
      if (!res.ok) return null;
      const data = await res.json() as { values: Array<{ id: number }> };
      return data.values?.[0]?.id ?? null;
    },

    async findExistingComment(prId) {
      const res = await api(`/repositories/${repoPath}/pullrequests/${prId}/comments?pagelen=100`);
      if (!res.ok) return null;
      const data = await res.json() as { values: Array<{ id: number; content: { raw: string } }> };
      const existing = data.values?.find((c) => c.content.raw.includes(COMMENT_MARKER));
      return existing?.id ?? null;
    },

    async createComment(prId, body) {
      await api(`/repositories/${repoPath}/pullrequests/${prId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { raw: body } }),
      });
    },

    async updateComment(prId, commentId, body) {
      await api(`/repositories/${repoPath}/pullrequests/${prId}/comments/${commentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { raw: body } }),
      });
    },
  };
}
