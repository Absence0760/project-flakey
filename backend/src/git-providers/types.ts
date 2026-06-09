export type GitPlatform = "github" | "gitlab" | "bitbucket";

export interface GitProviderConfig {
  platform: GitPlatform;
  token: string;
  repo: string;
  baseUrl?: string;
}

export type CommitStatusState = "success" | "failure" | "pending";

export interface CommitStatusParams {
  commitSha: string;
  state: CommitStatusState;
  targetUrl: string;
  description: string;
  context: string;
}

// A single inline annotation on the diff (GitHub Checks API). Maps one failed
// test to the file/line it threw at, derived best-effort from the reporter's
// captured location (Playwright metadata.location / Cypress failure_context.code_frame).
export interface CheckAnnotation {
  path: string; // repo-relative file path
  start_line: number; // 1-indexed; defaults to 1 when only a file is known
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

export interface CheckRunParams {
  commitSha: string;
  name: string; // check-run name, e.g. "flakey/<suite>"
  title: string; // output title, e.g. "5 failed, 20 passed"
  summary: string;
  conclusion: "success" | "failure" | "neutral";
  detailsUrl: string;
  annotations: CheckAnnotation[];
}

export interface GitProvider {
  findPRByCommit(commitSha: string): Promise<number | null>;
  findPRByBranch(branch: string): Promise<number | null>;
  findExistingComment(prId: number): Promise<number | null>;
  createComment(prId: number, body: string): Promise<void>;
  updateComment(prId: number, commentId: number, body: string): Promise<void>;
  postCommitStatus(params: CommitStatusParams): Promise<void>;
  // Optional: per-failure inline annotations via a richer checks API. Only
  // GitHub implements it (the Checks API); GitLab/Bitbucket omit it and callers
  // guard with `provider.postChecksAnnotations?.(…)`.
  postChecksAnnotations?(params: CheckRunParams): Promise<void>;

  // ── Repo-write capability (open an AI-suggested fix as a DRAFT PR) ────────
  // All three providers implement these. DRAFT PRs only — there is
  // deliberately NO merge capability here; a human reviews and merges.

  // The repo's default branch + its current head sha (the base/branch-point
  // for a fix branch).
  getDefaultBranch(): Promise<{ name: string; sha: string }>;
  // Decoded utf-8 file content + the blob sha (needed by GitHub to update an
  // existing file). Returns null when the file does not exist at `ref`.
  getFileContent(path: string, ref: string): Promise<{ content: string; sha: string } | null>;
  // Create a new branch `name` pointing at `fromSha`.
  createBranch(name: string, fromSha: string): Promise<void>;
  // Create or update a single file on `branch`. Pass `sha` (the existing blob
  // sha from getFileContent) when updating an existing file — GitHub requires
  // it; GitLab/Bitbucket ignore it and switch create→update by themselves.
  commitFile(params: { branch: string; path: string; content: string; message: string; sha?: string }): Promise<void>;
  // Open a pull/merge request. `draft` opens it as a draft where the platform
  // supports it (Bitbucket Cloud has no draft flag — it opens normally).
  createPullRequest(params: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
}
