# @flakeytesting/mcp-server

MCP (Model Context Protocol) server that lets AI coding agents query test results from a Flakey/Better Testing backend.

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
- Tools should be read-only by default. Anything that mutates backend state (closing tickets, approving visual diffs) needs to be gated and clearly labeled.
