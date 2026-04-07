# Examples

Working examples showing how to integrate Flakey with different test frameworks. Each example is a standalone project you can clone, run, and see results appear in your Flakey dashboard.

Use these as a starting point for your own project, or run them locally to see Flakey in action.

## Structure

```
examples/
  shared/
    app/              ← Simple HTML app on port 4444 (the app under test)
      index.html      ← Login, Todos, Users table, Form
      serve.js        ← Node HTTP server (no dependencies)
    package.json
  cypress/            ← Standard Cypress
  cypress-cucumber/   ← Cypress with Gherkin/Cucumber
  playwright/         ← Playwright
  selenium/           ← Selenium + JUnit XML
```

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

1. Flakey backend running on `http://localhost:3000`
2. Flakey frontend running on `http://localhost:7777`
3. An API key from Flakey (Profile > API Keys)

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
FLAKEY_API_KEY=fk_your_key pnpm test

# Cypress + Cucumber
cd examples/cypress-cucumber
pnpm install
FLAKEY_API_KEY=fk_your_key pnpm test

# Playwright
cd examples/playwright
pnpm install
FLAKEY_API_KEY=fk_your_key pnpm test

# Selenium
cd examples/selenium
pnpm install
pnpm test
# Selenium uses the CLI to upload results after the run
```

### Verify results

After a test run, check Flakey:
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

## Flakey Setup

Each example is pre-configured to upload results to Flakey. Here's how each framework connects:

| Framework | Reporter | Upload Method |
|---|---|---|
| Cypress | `@flakeytesting/reporter` | Direct (after:run plugin) |
| Cypress + Cucumber | `@flakeytesting/reporter` | Direct (after:run plugin) |
| Playwright | `@flakeytesting/reporter` | Direct (onEnd hook) |
| Selenium | mochawesome / JUnit | CLI upload after run |

### Cypress / Cypress + Cucumber config

```typescript
import { flakeyReporter } from "@flakeytesting/reporter/plugin";

export default defineConfig({
  reporter: "@flakeytesting/reporter/dist/cypress-reporter.cjs",
  reporterOptions: {
    url: "http://localhost:3000",
    apiKey: process.env.FLAKEY_API_KEY,
    suite: "integration-cypress",  // or "integration-cypress-cucumber"
  },
  e2e: {
    baseUrl: "http://localhost:4444",
    setupNodeEvents(on, config) {
      flakeyReporter(on, config);
      return config;
    },
  },
});
```

### Playwright config

```typescript
export default defineConfig({
  use: { baseURL: "http://localhost:4444" },
  reporter: [
    ["@flakeytesting/reporter/dist/playwright-reporter.js", {
      url: "http://localhost:3000",
      apiKey: process.env.FLAKEY_API_KEY,
      suite: "integration-playwright",
    }],
  ],
});
```

### Selenium

Selenium doesn't have a native Flakey reporter. Use a standard reporter (JUnit XML or mochawesome) and upload via the CLI:

```bash
# Run tests (generates JUnit XML)
pnpm test

# Upload to Flakey
npx tsx ../../packages/cli/src/index.ts \
  --report-dir test-results \
  --suite integration-selenium \
  --reporter junit \
  --api-key $FLAKEY_API_KEY
```

## Adding an example for a new framework

1. Create a new directory under `examples/`
2. Initialize with `pnpm init`
3. Install the framework and `@flakeytesting/reporter`
4. Write tests against `http://localhost:4444` using the data-testid selectors
5. Configure the reporter to upload to `http://localhost:3000`
6. Add a `pnpm test` script
7. Update this doc
