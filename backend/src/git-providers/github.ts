import type { GitProvider, GitProviderConfig, CommitStatusParams, CheckRunParams } from "./types.js";
import { COMMENT_MARKER } from "./comment.js";

// GitHub's Checks API accepts at most 50 annotations per create/update request.
const MAX_ANNOTATIONS_PER_REQUEST = 50;

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

    // Create a completed check-run with per-failure inline annotations. The
    // Checks API caps annotations at 50/request, so the first batch is sent on
    // create and any remainder is PATCHed onto the same check-run id (GitHub
    // accumulates annotations across updates). Requires a token with
    // `checks:write` — a fine-grained PAT or GitHub App installation token;
    // a classic repo-scoped token does NOT grant it (surfaced as 403 here).
    async postChecksAnnotations(params: CheckRunParams) {
      const batches: CheckRunParams["annotations"][] = [];
      for (let i = 0; i < params.annotations.length; i += MAX_ANNOTATIONS_PER_REQUEST) {
        batches.push(params.annotations.slice(i, i + MAX_ANNOTATIONS_PER_REQUEST));
      }
      // Always create the check-run, even with zero annotations (a green run
      // still reports a passing check). The output object is required by the API.
      const output = (annotations: CheckRunParams["annotations"]) => ({
        title: params.title,
        summary: params.summary,
        annotations,
      });

      const createRes = await api(`/repos/${owner}/${repo}/check-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: params.name,
          head_sha: params.commitSha,
          status: "completed",
          conclusion: params.conclusion,
          details_url: params.detailsUrl,
          output: output(batches[0] ?? []),
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.text().catch(() => "");
        throw new Error(`GitHub POST /check-runs → ${createRes.status}: ${body.slice(0, 200)}`);
      }
      const { id } = await createRes.json() as { id: number };

      // Remaining batches update the same check-run.
      for (let b = 1; b < batches.length; b++) {
        await apiOrThrow(`/repos/${owner}/${repo}/check-runs/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ output: output(batches[b]) }),
        });
      }
    },
  };
}
