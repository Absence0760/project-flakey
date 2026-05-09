import { test, mock } from "node:test";
import { strict as assert } from "node:assert";

import { registerTools, type ToolServer } from "../tools.ts";
import type { Api } from "../api.ts";

/**
 * Unit tests for the MCP tool registry. Drive `registerTools` against a
 * fake server that captures (name, description, args, handler) tuples
 * so individual tool handlers can be invoked and the underlying API
 * call shape (path + method + body) asserted.
 *
 * These tests don't spin up the real McpServer / StdioTransport — that
 * surface is exercised at protocol-level integration time via the MCP
 * SDK's own conformance tests. Here we cover what's specific to Flakey:
 * the URL/method/body each tool sends and the mutation gate.
 */

interface CapturedTool {
  name: string;
  description: string;
  args: Record<string, unknown>;
  handler: (input: any) => Promise<unknown> | unknown;
}

function fakeServer(): { server: ToolServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  const server: ToolServer = {
    tool(name, description, args, handler) {
      tools.push({ name, description, args: args as any, handler: handler as any });
    },
  };
  return { server, tools };
}

interface ApiCall {
  path: string;
  opts?: RequestInit;
}

function fakeApi(): { api: Api; calls: ApiCall[]; respond: (path: string) => unknown } {
  const calls: ApiCall[] = [];
  let responder: (path: string) => unknown = () => ({ ok: true });
  const api: Api = mock.fn(async (path: string, opts?: RequestInit) => {
    calls.push({ path, opts });
    return responder(path);
  });
  return {
    api,
    calls,
    set respond(fn: (path: string) => unknown) {
      responder = fn;
    },
    get respond() {
      return responder;
    },
  } as { api: Api; calls: ApiCall[]; respond: (path: string) => unknown };
}

test("registerTools registers the read-only tools by default; mutation tools are SKIPPED", () => {
  const { server, tools } = fakeServer();
  const { api } = fakeApi();
  const skipped: string[] = [];
  registerTools(server, { api, log: (m) => skipped.push(m) });

  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "get_errors",
    "get_flaky_tests",
    "get_quarantined_tests",
    "get_run",
    "get_runs",
    "get_slowest_tests",
    "get_stats",
    "get_test_history",
    "predict_tests",
  ], "with allowMutations off, only read-only tools should be registered");

  // analyze_error is the lone mutation tool today.
  assert.ok(skipped.some((m) => m.includes("analyze_error")),
    "skipping analyze_error should be logged so operators can see it's gated off");
  assert.equal(tools.find((t) => t.name === "analyze_error"), undefined,
    "the mutation tool must NOT be registered when allowMutations is off");
});

test("with allowMutations: true, analyze_error registers with a [mutates server state] prefix", () => {
  const { server, tools } = fakeServer();
  const { api } = fakeApi();
  registerTools(server, { api, allowMutations: true, log: () => {} });

  const analyze = tools.find((t) => t.name === "analyze_error");
  assert.ok(analyze, "analyze_error should be registered when mutations are allowed");
  assert.match(analyze!.description, /^\[mutates server state\] /,
    "the description shown to the model must lead with the [mutates server state] tag");
});

test("get_runs handler GETs /runs and returns the response as text content", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  apiHelper.respond = () => [{ id: 1, suite: "demo", failed: 0 }];
  registerTools(server, { api: apiHelper.api, log: () => {} });

  const getRuns = tools.find((t) => t.name === "get_runs")!;
  const result = (await getRuns.handler({})) as {
    content: { type: string; text: string }[];
  };

  assert.equal(apiHelper.calls.length, 1);
  assert.equal(apiHelper.calls[0].path, "/runs");
  assert.equal(apiHelper.calls[0].opts, undefined,
    "get_runs is a plain GET — no options passed");
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed, [{ id: 1, suite: "demo", failed: 0 }]);
});

test("get_run hits /runs/<id> with the supplied numeric id", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  apiHelper.respond = (path) => ({ id: Number(path.split("/").pop()) });
  registerTools(server, { api: apiHelper.api, log: () => {} });

  const getRun = tools.find((t) => t.name === "get_run")!;
  await getRun.handler({ run_id: 4242 });

  assert.equal(apiHelper.calls[0].path, "/runs/4242");
});

test("get_flaky_tests builds the querystring from optional suite + runs", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });

  const tool = tools.find((t) => t.name === "get_flaky_tests")!;

  await tool.handler({});
  assert.equal(apiHelper.calls[0].path, "/flaky?",
    "no filters → empty querystring");

  await tool.handler({ suite: "auth-e2e" });
  assert.equal(apiHelper.calls[1].path, "/flaky?suite=auth-e2e");

  await tool.handler({ runs: 50 });
  assert.equal(apiHelper.calls[2].path, "/flaky?runs=50");

  await tool.handler({ suite: "auth-e2e", runs: 50 });
  assert.equal(apiHelper.calls[3].path, "/flaky?suite=auth-e2e&runs=50");
});

test("get_errors composes both suite + status filters into the querystring", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });

  await tools.find((t) => t.name === "get_errors")!.handler({
    suite: "auth-e2e", status: "investigating",
  });
  assert.equal(apiHelper.calls[0].path, "/errors?suite=auth-e2e&status=investigating");
});

test("get_test_history requires test_id and uses path-style routing (/tests/<id>/history)", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });
  await tools.find((t) => t.name === "get_test_history")!.handler({ test_id: 999 });
  assert.equal(apiHelper.calls[0].path, "/tests/999/history");
});

test("predict_tests POSTs to /predict/tests with the body shape the backend expects", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });

  await tools.find((t) => t.name === "predict_tests")!.handler({
    changed_files: ["src/auth/login.ts", "src/api/users.ts"],
    suite: "auth-e2e",
  });

  const call = apiHelper.calls[0];
  assert.equal(call.path, "/predict/tests");
  assert.equal(call.opts?.method, "POST");
  // The MCP arg is `changed_files` (snake-case; matches MCP convention)
  // but the backend expects `changedFiles` (camel) — pin the rename.
  const body = JSON.parse(call.opts!.body as string);
  assert.deepEqual(body, {
    changedFiles: ["src/auth/login.ts", "src/api/users.ts"],
    suite: "auth-e2e",
  });
});

test("get_quarantined_tests with no suite uses an empty querystring (no '?suite=undefined')", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });

  await tools.find((t) => t.name === "get_quarantined_tests")!.handler({});
  assert.equal(apiHelper.calls[0].path, "/quarantine",
    "missing optional `suite` should NOT inject 'undefined' into the URL");
});

test("get_quarantined_tests URL-encodes special chars in suite name (%, /, space, etc.)", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });

  await tools.find((t) => t.name === "get_quarantined_tests")!.handler({
    suite: "auth & checkout/v2",
  });
  assert.equal(apiHelper.calls[0].path, "/quarantine?suite=auth%20%26%20checkout%2Fv2",
    "raw suite names with special chars must be encodeURIComponent'd, not concatenated");
});

test("analyze_error (mutation gate ON) POSTs /analyze/error/<fingerprint>", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, allowMutations: true, log: () => {} });

  await tools.find((t) => t.name === "analyze_error")!.handler({
    fingerprint: "deadbeef0123456789abcdef00000001",
  });

  const call = apiHelper.calls[0];
  assert.equal(call.path, "/analyze/error/deadbeef0123456789abcdef00000001");
  assert.equal(call.opts?.method, "POST");
});

test("get_slowest_tests with no suite goes to /slowest (no querystring)", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });

  await tools.find((t) => t.name === "get_slowest_tests")!.handler({});
  assert.equal(apiHelper.calls[0].path, "/slowest");
});

test("get_stats composes optional from + to date params", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  registerTools(server, { api: apiHelper.api, log: () => {} });

  const tool = tools.find((t) => t.name === "get_stats")!;
  await tool.handler({});
  assert.equal(apiHelper.calls[0].path, "/stats?",
    "no filters → empty querystring");

  await tool.handler({ from: "2026-01-01" });
  assert.equal(apiHelper.calls[1].path, "/stats?from=2026-01-01");

  await tool.handler({ from: "2026-01-01", to: "2026-02-01" });
  assert.equal(apiHelper.calls[2].path, "/stats?from=2026-01-01&to=2026-02-01");
});

test("every read-only tool's response wraps the payload in a {content:[{type:'text',text:JSON}]} envelope", async () => {
  const { server, tools } = fakeServer();
  const apiHelper = fakeApi();
  apiHelper.respond = () => ({ marker: "PAYLOAD" });
  registerTools(server, { api: apiHelper.api, log: () => {} });

  // Walk every read-only tool and confirm the envelope.
  for (const tool of tools) {
    if (tool.name === "predict_tests") continue; // requires changed_files arg
    if (tool.name === "get_run" || tool.name === "get_test_history") continue; // requires id
    const out = (await tool.handler({})) as { content: { type: string; text: string }[] };
    assert.equal(out.content?.[0]?.type, "text", `tool ${tool.name} should produce a text content block`);
    assert.match(out.content[0].text, /"marker":\s*"PAYLOAD"/,
      `tool ${tool.name} must JSON-stringify the api response into the text block`);
  }
});
