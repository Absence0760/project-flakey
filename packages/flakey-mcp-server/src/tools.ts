/**
 * MCP tool registration for the Flakey/Better-Testing server.
 *
 * Extracted from index.ts so registration is testable without spinning
 * up the actual McpServer + StdioServerTransport. The `server` parameter
 * is intentionally typed loosely as `ToolServer` — a structural subset
 * of McpServer's tool API — so a test can pass a tiny fake that just
 * captures (name, description, args, handler) tuples.
 */

import { z, type ZodRawShape } from "zod";
import type { Api } from "./api.js";

/**
 * Structural subset of McpServer.tool — anything that can register a
 * tool by name with a description, arg schema, and handler.
 */
export interface ToolServer {
  tool<A extends ZodRawShape>(
    name: string,
    description: string,
    args: A,
    handler: (input: { [K in keyof A]: z.infer<A[K]> }) => Promise<unknown> | unknown,
  ): void;
}

export interface RegisterToolsOpts {
  api: Api;
  /**
   * When false (default), tools marked `mutates: true` are skipped at
   * registration time — clients can't even see them. The Flakey CLI
   * sets this from FLAKEY_MCP_ALLOW_MUTATIONS env var.
   */
  allowMutations?: boolean;
  /**
   * Optional logger for the "skipped mutation tool" notices that
   * default to stderr in production. Tests can pass a no-op or a
   * collector to assert on the output.
   */
  log?: (msg: string) => void;
}

interface ToolOpts {
  mutates?: boolean;
}

export function registerTools(server: ToolServer, opts: RegisterToolsOpts): void {
  const { api, allowMutations = false, log = (m) => console.error(m) } = opts;

  function registerTool<A extends ZodRawShape>(
    name: string,
    description: string,
    args: A,
    handler: (input: { [K in keyof A]: z.infer<A[K]> }) => Promise<unknown> | unknown,
    toolOpts: ToolOpts = {},
  ): void {
    if (toolOpts.mutates && !allowMutations) {
      log(
        `[flakey-mcp] Skipping mutation tool "${name}" ` +
          `(set FLAKEY_MCP_ALLOW_MUTATIONS=1 to enable).`,
      );
      return;
    }
    const finalDescription = toolOpts.mutates
      ? `[mutates server state] ${description}`
      : description;
    server.tool<A>(name, finalDescription, args, handler);
  }

  registerTool(
    "get_runs",
    "List recent test runs. Returns run ID, suite, branch, pass/fail counts, and duration.",
    {},
    async () => {
      const runs = await api("/runs");
      return { content: [{ type: "text", text: JSON.stringify(runs, null, 2) }] };
    },
  );

  registerTool(
    "get_run",
    "Get full details for a specific test run, including all specs and tests with errors.",
    { run_id: z.number().describe("The run ID to fetch") },
    async ({ run_id }) => {
      const run = await api(`/runs/${run_id}`);
      return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }] };
    },
  );

  registerTool(
    "get_flaky_tests",
    "List flaky tests — tests that alternate between passing and failing. Shows flaky rate, flip count, and timeline.",
    {
      suite: z.string().optional().describe("Filter by suite name"),
      runs: z.number().optional().describe("Number of recent runs to analyze (default 30)"),
    },
    async ({ suite, runs }) => {
      const params = new URLSearchParams();
      if (suite) params.set("suite", suite);
      if (runs) params.set("runs", String(runs));
      const result = await api(`/flaky?${params}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "get_errors",
    "List recurring test failures grouped by error message. Shows occurrence count, affected tests, and status.",
    {
      suite: z.string().optional().describe("Filter by suite name"),
      status: z.string().optional().describe("Filter by status: open, investigating, known, fixed, ignored"),
    },
    async ({ suite, status }) => {
      const params = new URLSearchParams();
      if (suite) params.set("suite", suite);
      if (status) params.set("status", status);
      const result = await api(`/errors?${params}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "get_test_history",
    "Get the pass/fail history for a specific test across runs.",
    { test_id: z.number().describe("The test ID") },
    async ({ test_id }) => {
      const result = await api(`/tests/${test_id}/history`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "predict_tests",
    "Predict which tests to run based on changed files. Returns a ranked list of tests with relevance scores.",
    {
      changed_files: z.array(z.string()).describe("List of changed file paths (e.g. ['src/auth/login.ts', 'src/api/users.ts'])"),
      suite: z.string().optional().describe("Filter by suite name"),
    },
    async ({ changed_files, suite }) => {
      const result = await api("/predict/tests", {
        method: "POST",
        body: JSON.stringify({ changedFiles: changed_files, suite }),
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "get_quarantined_tests",
    "List tests that are quarantined (skipped in CI due to flakiness).",
    { suite: z.string().optional().describe("Filter by suite name") },
    async ({ suite }) => {
      const params = suite ? `?suite=${encodeURIComponent(suite)}` : "";
      const result = await api(`/quarantine${params}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "analyze_error",
    "Use AI to classify a test failure and suggest a fix. Writes an analysis record to the backend. Requires AI to be configured on the server.",
    { fingerprint: z.string().describe("The error fingerprint (MD5 hash from the errors list)") },
    async ({ fingerprint }) => {
      const result = await api(`/analyze/error/${fingerprint}`, { method: "POST" });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
    { mutates: true },
  );

  registerTool(
    "get_slowest_tests",
    "List the slowest tests with P50/P95/P99 duration stats and trend analysis.",
    { suite: z.string().optional().describe("Filter by suite name") },
    async ({ suite }) => {
      const params = suite ? `?suite=${encodeURIComponent(suite)}` : "";
      const result = await api(`/slowest${params}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  registerTool(
    "get_stats",
    "Get dashboard statistics: total runs, tests, pass rate, recent failures.",
    {
      from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    },
    async ({ from, to }) => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const result = await api(`/stats?${params}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
