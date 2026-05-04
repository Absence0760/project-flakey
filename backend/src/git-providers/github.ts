import type { GitProvider, GitProviderConfig, CommitStatusParams } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";

export function createGitHubProvider(config: GitProviderConfig): GitProvider {
  const [owner, repo] = config.repo.split("/");
  const baseUrl = config.baseUrl ?? "https://api.github.com";

  // 10s timeout on every GitHub API call. fetch() has no default timeout,
  // so without this a hung GitHub.com would stall the post-upload PR
  // comment / commit-status flow indefinitely (caller's try/catch never
  // fires, the upload request itself returns OK but background work piles
  // up forever).
  async function api(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
  }

  // For mutating calls (POST/PATCH), we must surface non-2xx as thrown
  // errors. fetch() doesn't throw on 4xx/5xx, so an invalid token (401)
  // or bad payload (422) would silently no-op without this — leaving
  // operators thinking the integration works.
  async function apiOrThrow(path: string, options: RequestInit): Promise<void> {
    const res = await api(path, options);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub ${options.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
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
      await apiOrThrow(`/repos/${owner}/${repo}/issues/${prId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },

    async updateComment(_prId, commentId, body) {
      await apiOrThrow(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },

    async postCommitStatus(params: CommitStatusParams) {
      await apiOrThrow(`/repos/${owner}/${repo}/statuses/${params.commitSha}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: params.state,
          target_url: params.targetUrl,
          description: params.description,
          context: params.context,
        }),
      });
    },
  };
}
