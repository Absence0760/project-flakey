# MCP integration — Better Testing

`@flakeytesting/mcp-server` exposes Better Testing data as an MCP (Model Context Protocol) server. Once wired up, AI coding agents (Claude Code, Claude Desktop, Cursor) can query your test runs, flaky tests, errors, and coverage data directly from chat — no copy-pasting from the dashboard.

## Quick start

Install the package globally (or use `npx`):

```bash
npm install -g @flakeytesting/mcp-server
```

Then configure your MCP client (see sections below). You need:

| Variable | Description |
|---|---|
| `FLAKEY_API_URL` | Better Testing backend URL (e.g. `https://bt.yourcompany.com`) |
| `FLAKEY_API_KEY` | API key from Better Testing (Profile > API Keys) |

---

## Claude Code

### Add the server

```bash
claude mcp add flakey \
  --env FLAKEY_API_URL=https://bt.yourcompany.com \
  --env FLAKEY_API_KEY=fk_your_key \
  -- npx flakey-mcp
```

This writes a `.claude/mcp.json` entry in your project (or `~/.claude/mcp.json` globally if you pass `--global`). You can also edit the file directly:

### `.claude/mcp.json` snippet

```json
{
  "mcpServers": {
    "flakey": {
      "command": "npx",
      "args": ["flakey-mcp"],
      "env": {
        "FLAKEY_API_URL": "https://bt.yourcompany.com",
        "FLAKEY_API_KEY": "fk_your_key"
      }
    }
  }
}
```

For local development (backend on port 3000):

```json
{
  "mcpServers": {
    "flakey": {
      "command": "npx",
      "args": ["flakey-mcp"],
      "env": {
        "FLAKEY_API_URL": "http://localhost:3000",
        "FLAKEY_API_KEY": "fk_your_key"
      }
    }
  }
}
```

To enable mutation tools (AI can trigger AI analysis of errors):

```json
{
  "mcpServers": {
    "flakey": {
      "command": "npx",
      "args": ["flakey-mcp"],
      "env": {
        "FLAKEY_API_URL": "https://bt.yourcompany.com",
        "FLAKEY_API_KEY": "fk_your_key",
        "FLAKEY_MCP_ALLOW_MUTATIONS": "1"
      }
    }
  }
}
```

---

## Claude Desktop

Add the following block to your `claude_desktop_config.json` under `mcpServers`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "flakey": {
      "command": "npx",
      "args": ["flakey-mcp"],
      "env": {
        "FLAKEY_API_URL": "https://bt.yourcompany.com",
        "FLAKEY_API_KEY": "fk_your_key"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config. The server will appear in the MCP panel in the sidebar.

---

## Cursor

Cursor supports MCP via a project-level `.cursor/mcp.json` file (project-level) or `~/.cursor/mcp.json` (global). The format mirrors Claude Code:

**`.cursor/mcp.json`**

```json
{
  "mcpServers": {
    "flakey": {
      "command": "npx",
      "args": ["flakey-mcp"],
      "env": {
        "FLAKEY_API_URL": "https://bt.yourcompany.com",
        "FLAKEY_API_KEY": "fk_your_key"
      }
    }
  }
}
```

Enable MCP in Cursor: **Settings (Cmd+,) > Features > MCP Servers** — the server defined in `.cursor/mcp.json` should appear there after reloading the window.

---

## What you can ask

The server exposes 9 read-only tools by default (a 10th mutation tool is available when `FLAKEY_MCP_ALLOW_MUTATIONS=1`):

| Tool | What it does |
|---|---|
| `get_runs` | List recent test runs with ID, suite, branch, pass/fail counts, duration |
| `get_run` | Full details for one run: all specs, test names, error messages, durations |
| `get_flaky_tests` | Tests that alternate pass/fail — flaky rate, flip count, timeline |
| `get_errors` | Recurring failures grouped by error fingerprint, with occurrence count and status |
| `get_test_history` | Pass/fail history for a specific test across runs |
| `predict_tests` | Given a list of changed files, predict which tests are most likely to fail |
| `get_quarantined_tests` | Tests quarantined (skipped in CI) due to persistent flakiness |
| `get_slowest_tests` | Slowest tests with P50/P95/P99 duration and trend |
| `get_stats` | Dashboard stats: total runs, pass rate, recent failures (optionally date-filtered) |

**Mutation tool (requires `FLAKEY_MCP_ALLOW_MUTATIONS=1`):**

| Tool | What it does |
|---|---|
| `analyze_error` | Trigger AI analysis of a specific error fingerprint; writes classification and fix suggestion to the backend |

Tools labelled `[mutates server state]` are only registered (and visible to the AI) when the mutation flag is set. With the default config the AI cannot accidentally trigger side effects.

---

## End-to-end example: from Cypress failure to fix in 3 steps

Scenario: a test that was passing started failing on a feature branch. You want to understand why and fix it.

### Step 1 — Ask Claude Code to investigate

```
What tests are failing in our cypress-example-smoke suite?
```

Claude calls `get_runs` to find recent runs, then `get_run` with the latest run ID to read the failing test's error message and stack trace.

**Sample output from `get_run`:**

```json
{
  "id": 142,
  "suite_name": "cypress-example-smoke",
  "branch": "feat/new-login",
  "tests": [
    {
      "id": 8814,
      "title": "Login > redirects to todos page after success",
      "status": "failed",
      "error": "AssertionError: expected '/todos' to equal '#todos'\n  at Context.<anonymous> (cypress/e2e/smoke/login.cy.ts:22:31)"
    }
  ]
}
```

### Step 2 — Claude reads the failing test and the source

Claude reads `cypress/e2e/smoke/login.cy.ts` and `examples/shared/app/index.html` to understand the mismatch — the app uses hash routing (`#todos`) but the test was asserting on pathname (`/todos`).

### Step 3 — Claude proposes the fix

```typescript
// Before
cy.url().should("eq", "http://localhost:4444/todos");

// After
cy.url().should("include", "#todos");
```

Claude edits the file, runs `pnpm test:smoke`, and the test passes.

---

This whole flow — `get_runs` → `get_run` → read code → edit → re-run — takes about 2 minutes. Without MCP you would: open the dashboard, find the run, copy the error, find the file, fix the assertion, run tests. MCP removes the copy-paste and context-switching.
