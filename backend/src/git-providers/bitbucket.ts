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

    // ── Repo-write (fix PRs — Bitbucket Cloud has no draft flag) ─────────────

    async getDefaultBranch() {
      const res = await api(`/repositories/${repoPath}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Bitbucket GET /repositories/${repoPath} → ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json() as { mainbranch: { name: string } };
      const name = data.mainbranch.name;
      const refRes = await api(`/repositories/${repoPath}/refs/branches/${encodeURIComponent(name)}`);
      if (!refRes.ok) {
        const body = await refRes.text().catch(() => "");
        throw new Error(`Bitbucket GET /refs/branches/${name} → ${refRes.status}: ${body.slice(0, 200)}`);
      }
      const ref = await refRes.json() as { target: { hash: string } };
      return { name, sha: ref.target.hash };
    },

    async getFileContent(path, ref) {
      // The /src endpoint returns the file's RAW bytes, not a JSON envelope.
      // Encode each path segment (preserving the "/" separators) so a file path
      // with spaces or percent-signs doesn't corrupt the URL — a naive
      // encodeURIComponent(path) would also escape the slashes and break nesting.
      const encPath = path.split("/").map(encodeURIComponent).join("/");
      const res = await api(`/repositories/${repoPath}/src/${encodeURIComponent(ref)}/${encPath}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Bitbucket GET /src/${ref}/${path} → ${res.status}: ${body.slice(0, 200)}`);
      }
      const content = await res.text();
      // Bitbucket has no per-file blob sha in this response; the commit-on-/src
      // flow doesn't need one (it switches create→update server-side), so we
      // surface the source ref as the sha for interface symmetry.
      return { content, sha: ref };
    },

    async createBranch(name, fromSha) {
      await apiOrThrow(`/repositories/${repoPath}/refs/branches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, target: { hash: fromSha } }),
      });
    },

    async commitFile(params) {
      // The /src commit endpoint is form-encoded: each form field whose name is
      // a repo path becomes that file's new content. `branch` + `message` are
      // reserved fields. It creates or updates server-side, so no sha needed.
      const form = new URLSearchParams();
      form.set(params.path, params.content);
      form.set("branch", params.branch);
      form.set("message", params.message);
      await apiOrThrow(`/repositories/${repoPath}/src`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
    },

    async createPullRequest(params) {
      // Bitbucket Cloud has no draft flag; open normally and prefix the body so
      // a reviewer knows it's an AI-generated suggestion awaiting review.
      const description = params.draft
        ? `> :robot: AI-generated suggestion — review before merging.\n\n${params.body}`
        : params.body;
      const res = await api(`/repositories/${repoPath}/pullrequests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: params.title,
          description,
          source: { branch: { name: params.head } },
          destination: { branch: { name: params.base } },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Bitbucket POST /pullrequests → ${res.status}: ${body.slice(0, 200)}`);
      }
      const pr = await res.json() as { id: number; links: { html: { href: string } } };
      return { number: pr.id, url: pr.links.html.href };
    },
  };
}
