# Examples

Working examples showing how to integrate Better Testing with different test frameworks. Each example is a standalone project you can clone, run, and see results appear in your Better Testing dashboard.

Use these as a starting point for your own project, or run them locally to see Better Testing in action.

## Features matrix

Which product features each example exercises. `✓` = wired; `—` = not applicable to this example.

| Feature | Cypress | Playwright | WebdriverIO | Selenium | Jest | Postman | ZAP | CI | MCP |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| DOM snapshots | ✓ | ✓ | — | — | — | — | — | — | — |
| Accessibility (a11y) | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — |
| Visual regression | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — |
| Flaky detection | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | ✓ |
| Coverage upload | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| Release linking | — | — | — | — | — | — | — | — | — |
| Jira / PagerDuty | — | — | — | — | — | — | — | — | — |
| CI PR integration | — | — | — | — | — | — | — | ✓ | — |
| MCP integration | — | — | — | — | — | — | — | — | ✓ |
| Security scan | — | — | — | — | — | — | ✓ | — | — |
| API tests | — | — | — | — | — | ✓ | — | — | — |

Notes:
- **DOM snapshots**: full DOM capture per test step, replayable in the dashboard.
- **Flaky detection**: each example includes an intentional flaky test in a `flaky/` folder that you can run separately to seed flaky data.
- **CI PR integration**: the CI templates show how the backend posts PR status/comments via GitHub/GitLab/Bitbucket APIs.
- **MCP integration**: the MCP example shows how to query Better Testing from Claude Code, Claude Desktop, or Cursor.

## Structure

```
examples/
  shared/
    app/              ← Simple HTML app on port 4444 (the app under test)
      index.html      ← Login, Todos, Users table, Form
      serve.js        ← Node HTTP server (no dependencies)
    package.json
  cypress/            ← Cypress example with 4 suites (smoke, sanity, regression, live)
  playwright/         ← Playwright example with 3 suites
  selenium/           ← Selenium + Mocha example with CLI upload
  webdriverio/        ← WebdriverIO example
  cypress-cucumber/   ← Cypress with Cucumber syntax
  postman/            ← Postman (Newman) API tests with JUnit upload
  zap/                ← OWASP ZAP security scan with JUnit conversion
  jest/               ← Jest unit tests with JUnit upload and coverage
  ci/                 ← CI workflow templates (GitHub Actions, GitLab, Bitbucket)
  mcp/                ← MCP server config for Claude Code, Claude Desktop, Cursor
```

### Live reporting demo

The Cypress example includes a `live` suite that demonstrates real-time test progress streaming:

```bash
cd examples/cypress
pnpm test:live
```

This uses `@flakeytesting/live-reporter` alongside the main Cypress reporter. The run appears in the Better Testing dashboard immediately with a pulsing LIVE badge, and test results stream in as each spec completes.

## Sample App

A single-page HTML app with no backend dependencies. All state is in-memory (resets on refresh).

**URL:** `http://localhost:4444`

### Pages

| Page | URL | What it tests |
|---|---|---|
| Login | `#login` | Form validation, success/error states, redirect |
| Todos | `#todos` | CRUD operations, checkbox toggle, filtering, keyboard input |
| Users | `#users` | Table rendering, column sorting, delete with modal confirmation |
| Form | `#form` | Multi-field form, select/textarea/checkbox, submit, reset |

### Test Credentials

- **Email:** `admin@test.com`
- **Password:** `password`

### Data-testid Attributes

All interactive elements have `data-testid` attributes for reliable selectors:

**Login:**
- `login-page`, `login-form`
- `email-input`, `password-input`, `login-button`
- `login-error`, `login-success`

**Todos:**
- `todos-page`, `todo-input`, `add-todo`, `todo-list`
- `todo-item-{id}`, `todo-check-{id}`, `todo-text-{id}`, `todo-delete-{id}`
- `todo-count`, `filter-all`, `filter-active`, `filter-completed`

**Users:**
- `users-page`, `users-table`, `users-body`
- `sort-name`, `sort-email`, `sort-role`
- `user-row-{email}`, `delete-{email}`
- `delete-modal`, `cancel-delete`, `confirm-delete`

**Form:**
- `form-page`, `create-form`
- `item-name`, `item-category`, `item-priority`, `item-description`, `item-urgent`
- `submit-form`, `reset-form`, `form-result`

## Running

### Prerequisites

1. Better Testing backend running on `http://localhost:3000`
2. Better Testing frontend running on `http://localhost:7777`
3. An API key from Better Testing (Profile > API Keys)

### Start the sample app

```bash
cd examples/shared
pnpm start
# or: node app/serve.js
```

The app runs on `http://localhost:4444`.

### Run an example

Each example is a standalone project. Install and run:

```bash
# Cypress
cd examples/cypress
pnpm install
FLAKEY_API_KEY=fk_your_key pnpm test:smoke

# Playwright
cd examples/playwright
pnpm install
FLAKEY_API_KEY=fk_your_key pnpm test:smoke

# Selenium
cd examples/selenium
pnpm install
pnpm test:smoke
# Selenium uses the CLI to upload results after the run

# WebdriverIO
cd examples/webdriverio
pnpm install
FLAKEY_API_KEY=fk_your_key pnpm test:smoke

# Jest (unit tests — no browser, no sample app needed)
cd examples/jest
pnpm install --ignore-workspace
FLAKEY_API_KEY=fk_your_key pnpm test:smoke
# Upload results manually:
node scripts/upload.js smoke

# CI templates — copy-paste only, no execution needed
# See examples/ci/README.md for instructions.

# MCP server — documentation only
# See examples/mcp/README.md for client config snippets.
```

### Verify results

After a test run, check Better Testing:
- `http://localhost:7777` — the run should appear on the dashboard
- `http://localhost:3000/runs` — API endpoint should list the new run

## What each example covers

Every example tests the same scenarios so you can compare how different frameworks handle them:

### Login
- Successful login with valid credentials
- Failed login with invalid credentials
- Error message appears on failure
- Redirect to Todos page after success

### Todos
- Add a new todo item
- Mark a todo as completed
- Delete a todo item
- Filter todos (all / active / completed)
- Counter updates correctly

### Users Table
- Table renders all users
- Sort by name, email, role
- Delete user with modal confirmation
- Cancel delete closes modal

### Form
- Submit with required fields
- Submit shows result message
- Reset clears all fields
- Select dropdowns work
- Checkbox toggle works

## Better Testing Setup

Each example is pre-configured to upload results to Better Testing. Here's how each framework connects:

| Framework | Reporter | Upload Method |
|---|---|---|
| Cypress | `@flakeytesting/cypress-reporter` | Direct (after:run plugin) |
| Playwright | `@flakeytesting/playwright-reporter` | Direct (onEnd hook) |
| WebdriverIO | `@flakeytesting/webdriverio-reporter` | Direct (onComplete hook) |
| Selenium | mochawesome / JUnit | CLI upload after run |
| Jest | `jest-junit` (JUnit XML) | CLI upload after run |
| Postman (Newman) | JUnit XML | CLI upload after run |
| OWASP ZAP | JSON → JUnit XML converter | CLI upload after run |

### Cypress config

```typescript
import { setupFlakey } from "@flakeytesting/cypress-reporter/plugin";

export default defineConfig({
  reporter: "@flakeytesting/cypress-reporter",
  reporterOptions: {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "integration-cypress",
  },
  e2e: {
    baseUrl: "http://localhost:4444",
    async setupNodeEvents(on, config) {
      await setupFlakey(on, config);
      return config;
    },
  },
});
```

```typescript
// cypress/support/e2e.ts
import "@flakeytesting/cypress-reporter/support";
import "@flakeytesting/cypress-snapshots/support";
// For Cucumber projects only — adds Gherkin step markers to the snapshot bundle:
// import "@flakeytesting/cypress-snapshots/cucumber";
```

`setupFlakey` is the canonical entry point. It registers the reporter plugin, the snapshot plugin (if `@flakeytesting/cypress-snapshots` is installed), and the live reporter (if `@flakeytesting/live-reporter` is installed). When the live reporter is active, DOM snapshots stream to the backend mid-run instead of only uploading at the end.

### Playwright config

```typescript
export default defineConfig({
  use: { baseURL: "http://localhost:4444" },
  reporter: [
    ["@flakeytesting/playwright-reporter", {
      url: "http://localhost:3000",
      apiKey: process.env.FLAKEY_API_KEY,
      suite: "integration-playwright",
    }],
  ],
});
```

### WebdriverIO config

```typescript
import FlakeyReporter from "@flakeytesting/webdriverio-reporter";

export const config = {
  reporters: [[FlakeyReporter, {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "integration-webdriverio",
  }]],
};
```

### Selenium

Selenium doesn't have a native Better Testing reporter. Use a standard reporter (JUnit XML or mochawesome) and upload via the CLI:

```bash
# Run tests and upload automatically
pnpm test:smoke

# To upload manually (matches scripts/upload.js):
npx tsx ../../packages/flakey-cli/src/index.ts \
  --report-dir reports \
  --suite selenium-example-smoke \
  --reporter mochawesome \
  --screenshots-dir screenshots \
  --api-key $FLAKEY_API_KEY
```

### Jest

Jest doesn't have a native Better Testing reporter. Use `jest-junit` to write JUnit XML and upload via the CLI:

```bash
cd examples/jest
pnpm install --ignore-workspace

# Run smoke tests (generates reports/junit.xml + coverage/smoke/coverage-summary.json)
FLAKEY_API_KEY=fk_your_key pnpm test:smoke

# Upload results
node scripts/upload.js smoke

# Upload coverage (replace 42 with the run ID printed by the upload step)
RUN_ID=42 node scripts/upload-coverage.js --coverage-dir coverage/smoke
```

See `examples/jest/README.md` for the full upload path explanation.

### Postman (Newman)

Run a Postman collection with Newman and upload JUnit results:

```bash
cd examples/postman
pnpm install

# Run API tests and upload
FLAKEY_API_KEY=fk_your_key pnpm test:smoke
```

Newman outputs JUnit XML, which the CLI uploads directly. Edit `collection.json` in Postman and re-export to add more tests.

### OWASP ZAP

Run a ZAP API security scan and upload results:

```bash
cd examples/zap
pnpm install

# Run ZAP scan against your API (requires Docker)
TARGET_URL=http://localhost:3000 FLAKEY_API_KEY=fk_your_key pnpm test:api
```

ZAP outputs its own JSON format. The `scripts/convert.js` script converts ZAP alerts to JUnit XML — each alert becomes a test case, with Low/Medium/High risk alerts reported as failures.

### CI workflow templates

See `examples/ci/` for copy-paste templates for GitHub Actions, GitLab CI, and Bitbucket Pipelines. Each template covers running a test suite, uploading results, and receiving PR status comments.

### MCP server

See `examples/mcp/README.md` for config snippets to add `@flakeytesting/mcp-server` to Claude Code, Claude Desktop, or Cursor.

## Adding an example for a new framework

1. Create a new directory under `examples/`
2. Initialize with `pnpm init`
3. Install the framework and the appropriate `@flakeytesting/*-reporter` package
4. Write tests against `http://localhost:4444` using the data-testid selectors
5. Configure the reporter to upload to `http://localhost:3000`
6. Add a `pnpm test` script
7. Update this doc
