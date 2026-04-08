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

export interface GitProvider {
  findPRByCommit(commitSha: string): Promise<number | null>;
  findPRByBranch(branch: string): Promise<number | null>;
  findExistingComment(prId: number): Promise<number | null>;
  createComment(prId: number, body: string): Promise<void>;
  updateComment(prId: number, commentId: number, body: string): Promise<void>;
  postCommitStatus(params: CommitStatusParams): Promise<void>;
}
