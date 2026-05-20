# @flakeytesting/mcp-server

Model Context Protocol (MCP) server for the [Flakey](https://github.com/Absence0760/project-flakey) test reporting dashboard. Lets AI coding agents — Claude Code, Claude Desktop, Cursor, Windsurf, Zed — query test results, find flaky tests, drill into failure history, and look up runs from the editor without leaving the conversation.

## Install

```bash
pnpm add -g @flakeytesting/mcp-server
# or
npm install -g @flakeytesting/mcp-server
```

A global install gives you a binary on your PATH. Per-project installs work too if you'd rather configure the MCP server with a `pnpm exec` / `npx` invocation.

## Quick start

### Claude Code

Add to `~/.claude/mcp.json` (or your project's `.mcp.json`):

```json
{
  "mcpServers": {
    "flakey": {
      "command": "flakey-mcp",
      "env": {
        "FLAKEY_API_URL": "https://flakey.your-domain.com",
        "FLAKEY_API_KEY": "fk_xxx..."
      }
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "flakey": {
      "command": "flakey-mcp",
      "env": {
        "FLAKEY_API_URL": "https://flakey.your-domain.com",
        "FLAKEY_API_KEY": "fk_xxx..."
      }
    }
  }
}
```

### Cursor / Windsurf

Same shape — refer to your editor's MCP-server configuration docs for the file location.

Restart the editor after editing the config. The MCP server connects to the Flakey backend the first time the agent issues a tool call.

## What the agent can do

The server exposes Flakey's read-API as MCP tools the agent can call:

- **`get_runs`** — list recent test runs, filter by suite / branch / status / environment
- **`get_run`** — fetch a single run's full detail (specs, tests, screenshots, error groups)
- **`get_flaky_tests`** — tests classified as flaky (alternating pass/fail across runs)
- **`get_errors`** — failures grouped by error fingerprint, with affected-test list
- **`get_test_history`** — per-test pass/fail history with prev/next failure pointers
- **`get_slowest_tests`** — tests by p95 duration (regression hunting)
- **`get_quarantined_tests`** — currently-quarantined tests in the org
- **`get_stats`** — dashboard aggregate stats with date-range filtering
- **`predict_tests`** — given a list of changed files, predict which tests likely need to run
- **`analyze_error`** — LLM-backed root-cause hypothesis for an error group (gated by the org's AI-provider config)

Read-only by default. Mutating tools are skipped at startup unless explicitly enabled — agents shouldn't be able to delete runs or change quarantine state without operator opt-in.

Typical agent workflows it unlocks:

- "Did my latest CI run pass?"
- "Show me every test that's failed in the last 24h on the main branch"
- "What's the most-flaky test in the auth suite?"
- "Find the run where `Login > rejects empty creds` first started failing"

## API key

The MCP server uses the same API keys the CLI does — create one in the Flakey dashboard under **Settings → API keys** and paste the full `fk_...` string into the `FLAKEY_API_KEY` env var. The key's org membership scopes every tool call, so a per-developer key is fine.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `FLAKEY_API_URL` | `http://localhost:3000` | Backend API URL |
| `FLAKEY_API_KEY` | _(required)_ | API key |

## Compatibility

- Node 20+
- MCP protocol: 2024-11-05 spec

## Links

- [Model Context Protocol spec](https://spec.modelcontextprotocol.io/)
- [Documentation site](https://github.com/Absence0760/project-flakey/blob/main/README.md)
- [Source + issues](https://github.com/Absence0760/project-flakey)
- License: MIT
