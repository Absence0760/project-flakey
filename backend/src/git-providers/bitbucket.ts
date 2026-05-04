import type { GitProvider, GitProviderConfig, CommitStatusParams, CommitStatusState } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";

export function createBitbucketProvider(config: GitProviderConfig): GitProvider {
  const baseUrl = (config.baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
  const repoPath = config.repo; // workspace/repo-slug

  // 10s timeout — see github.ts for rationale.
  async function api(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...options.headers,
      },
    });
  }

  async function apiOrThrow(path: string, options: RequestInit): Promise<void> {
    const res = await api(path, options);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Bitbucket ${options.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
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
      await apiOrThrow(`/repositories/${repoPath}/pullrequests/${prId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { raw: body } }),
      });
    },

    async updateComment(prId, commentId, body) {
      await apiOrThrow(`/repositories/${repoPath}/pullrequests/${prId}/comments/${commentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { raw: body } }),
      });
    },

    async postCommitStatus(params: CommitStatusParams) {
      // Bitbucket uses SUCCESSFUL/FAILED/INPROGRESS
      const stateMap: Record<CommitStatusState, string> = {
        success: "SUCCESSFUL",
        failure: "FAILED",
        pending: "INPROGRESS",
      };
      await apiOrThrow(`/repositories/${repoPath}/commit/${params.commitSha}/statuses/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: stateMap[params.state],
          key: params.context,
          name: params.context,
          url: params.targetUrl,
          description: params.description,
        }),
      });
    },
  };
}
