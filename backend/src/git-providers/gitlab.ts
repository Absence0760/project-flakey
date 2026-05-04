import type { GitProvider, GitProviderConfig, CommitStatusParams, CommitStatusState } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";

export function createGitLabProvider(config: GitProviderConfig): GitProvider {
  const baseUrl = (config.baseUrl ?? "https://gitlab.com").replace(/\/+$/, "");
  const projectId = encodeURIComponent(config.repo);

  // 10s timeout — see github.ts for rationale.
  async function api(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/v4${path}`, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: {
        "PRIVATE-TOKEN": config.token,
        ...options.headers,
      },
    });
  }

  async function apiOrThrow(path: string, options: RequestInit): Promise<void> {
    const res = await api(path, options);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitLab ${options.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`);
    }
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
      await apiOrThrow(`/projects/${projectId}/merge_requests/${mrIid}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },

    async updateComment(mrIid, noteId, body) {
      await apiOrThrow(`/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    },

    async postCommitStatus(params: CommitStatusParams) {
      // GitLab uses different state names
      const stateMap: Record<CommitStatusState, string> = {
        success: "success",
        failure: "failed",
        pending: "pending",
      };
      await apiOrThrow(`/projects/${projectId}/statuses/${params.commitSha}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: stateMap[params.state],
          target_url: params.targetUrl,
          description: params.description,
          name: params.context,
        }),
      });
    },
  };
}
