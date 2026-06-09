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

    // ── Repo-write (DRAFT fix MRs) ──────────────────────────────────────────

    async getDefaultBranch() {
      const projRes = await api(`/projects/${projectId}`);
      if (!projRes.ok) {
        const body = await projRes.text().catch(() => "");
        throw new Error(`GitLab GET /projects/${projectId} → ${projRes.status}: ${body.slice(0, 200)}`);
      }
      const { default_branch } = await projRes.json() as { default_branch: string };
      const branchRes = await api(`/projects/${projectId}/repository/branches/${encodeURIComponent(default_branch)}`);
      if (!branchRes.ok) {
        const body = await branchRes.text().catch(() => "");
        throw new Error(`GitLab GET /repository/branches/${default_branch} → ${branchRes.status}: ${body.slice(0, 200)}`);
      }
      const branch = await branchRes.json() as { commit: { id: string } };
      return { name: default_branch, sha: branch.commit.id };
    },

    async getFileContent(path, ref) {
      const res = await api(`/projects/${projectId}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GitLab GET /repository/files/${path} → ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json() as { content: string; encoding: string; blob_id: string };
      const content = data.encoding === "base64"
        ? Buffer.from(data.content, "base64").toString("utf-8")
        : data.content;
      return { content, sha: data.blob_id };
    },

    async createBranch(name, fromSha) {
      await apiOrThrow(
        `/projects/${projectId}/repository/branches?branch=${encodeURIComponent(name)}&ref=${encodeURIComponent(fromSha)}`,
        { method: "POST" },
      );
    },

    async commitFile(params) {
      // GitLab's file API needs to know whether this is a create or update;
      // probe for the existing file and pick PUT (update) vs POST (create).
      const exists = await this.getFileContent(params.path, params.branch);
      await apiOrThrow(`/projects/${projectId}/repository/files/${encodeURIComponent(params.path)}`, {
        method: exists ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch: params.branch,
          content: params.content,
          commit_message: params.message,
        }),
      });
    },

    async createPullRequest(params) {
      const res = await api(`/projects/${projectId}/merge_requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_branch: params.head,
          target_branch: params.base,
          // GitLab marks an MR as draft via a "Draft: " title prefix.
          title: params.draft ? `Draft: ${params.title}` : params.title,
          description: params.body,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GitLab POST /merge_requests → ${res.status}: ${body.slice(0, 200)}`);
      }
      const mr = await res.json() as { iid: number; web_url: string };
      return { number: mr.iid, url: mr.web_url };
    },
  };
}
