# @flakeytesting/mcp-server

MCP (Model Context Protocol) server that lets AI coding agents query test results from a Flakey backend.

## Commands

- `pnpm build` — `tsc` → `dist/`
- `pnpm dev` — `tsx src/index.ts` (run straight from source)

## Bin

Published as `flakey-mcp` (see `bin` in `package.json`). Typically invoked via an MCP client config (Claude Code, Claude Desktop, etc.) rather than directly.

## Dependencies

- `@modelcontextprotocol/sdk` — official MCP SDK. Follow its tool/resource patterns; don't hand-roll protocol framing.
- `zod` — input validation for tool arguments. All new tools should declare Zod schemas for their inputs.

## Conventions

- Auth against the backend uses the same API-key model as the CLI — read `FLAKEY_API_KEY` / `FLAKEY_API_URL` from env.
- Tools should be read-only by default. Anything that mutates backend state (closing tickets, approving visual diffs) must be registered with `{ mutates: true }` via the `registerTool` helper in `src/index.ts`.
- The helper enforces the convention: mutation tools are only exposed when `FLAKEY_MCP_ALLOW_MUTATIONS` is truthy (`1` / `true` / `yes`). With the gate off, those tools are not registered at all — clients can't even see them. A stderr line is logged for each skipped tool at startup.
- The description shown to clients for a mutation tool is prefixed `[mutates server state]` so the label is visible to the model even when the gate is on.

## Tools → routes

All tools are thin, read-only wrappers over existing backend routes (auth + tenant isolation are enforced at the route layer via `requireAuth`/`tenantQuery` — the tools add no access of their own). The evidence-pulling trio (Phase 13):

| Tool | Route | Notes |
|---|---|---|
| `get_test_artifacts` | `GET /tests/:id` | Reshapes the row into a focused bundle: screenshot/video/snapshot **URLs** + `command_log` + Cypress `failure_context` (console / network / uncaught / retry trail). Relative artifact paths are resolved against `uploadsUrl` (`FLAKEY_API_URL` + `/uploads`); presigned absolute URLs pass through. `failure_context` is non-null only for Cypress runs uploaded by a reporter new enough to capture it. |
| `compare_runs` | `GET /compare?a=&b=` | Newly-failed / fixed / still-failing / flipped between two runs. |
| `get_similar_failures` | `POST /analyze/similar/:fingerprint` | POST, but **read-only** — it computes message similarity and writes nothing, so it carries no `mutates` flag (unlike `analyze_error`, which records an analysis). |
