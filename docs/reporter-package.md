# Reporter Packages

## Concept

Instead of generating mochawesome/JUnit output and normalizing it afterwards,
the `@flakeytesting/*-reporter` packages plug directly into each test framework
and POST results to the Flakey API in the unified schema.

No intermediate files. No normalizer needed. One package per framework.

---

## Package structure

The reporter functionality is split across multiple packages:

```
packages/
├── flakey-core/                  ← @flakeytesting/core (shared)
│   ├── src/
│   │   ├── api-client.ts        # shared HTTP POST logic
│   │   └── schema.ts            # unified schema types (shared with Flakey API)
│   └── package.json
├── flakey-cypress-reporter/      ← @flakeytesting/cypress-reporter
│   ├── src/
│   │   ├── cypress-reporter.ts  # Cypress-compatible reporter (Mocha-based)
│   │   ├── plugin.ts            # setupNodeEvents plugin
│   │   └── support.ts           # support file import
│   └── package.json
├── flakey-playwright-reporter/   ← @flakeytesting/playwright-reporter
│   ├── src/
│   │   └── playwright-reporter.ts
│   └── package.json
├── flakey-webdriverio-reporter/  ← @flakeytesting/webdriverio-reporter
│   ├── src/
│   │   └── webdriverio-reporter.ts
│   └── package.json
├── flakey-live-reporter/         ← @flakeytesting/live-reporter
│   ├── src/
│   │   ├── index.ts             # Core LiveClient (batched HTTP POST)
│   │   ├── mocha.ts             # Cypress/Mocha integration
│   │   └── playwright.ts        # Playwright integration
│   └── package.json
└── flakey-mcp-server/            ← @flakeytesting/mcp-server
    ├── src/
    │   └── index.ts             # MCP tools for AI coding agents
    └── package.json
```

---

## Installation

```bash
# Cypress
npm install --save-dev @flakeytesting/cypress-reporter

# Playwright
npm install --save-dev @flakeytesting/playwright-reporter

# WebdriverIO
npm install --save-dev @flakeytesting/webdriverio-reporter
```

---

## Cypress setup

Cypress uses Mocha under the hood. Custom reporters receive Mocha runner events.

### cypress.config.ts

```ts
import { defineConfig } from 'cypress'

export default defineConfig({
  reporter: '@flakeytesting/cypress-reporter',
  reporterOptions: {
    url: 'https://your-flakey-instance.com',
    token: process.env.FLAKEY_TOKEN,
    suite: 'regression-suite',
    project: 'encor-tests',
  },
  e2e: {
    // ...
  },
})
```

### How it works internally (cypress-reporter.ts)

```ts
import Mocha from 'mocha'
import { ApiClient } from './api-client'
import { NormalizedRun, NormalizedTest } from './schema'

class FlakeyCypressReporter extends Mocha.reporters.Base {
  private client: ApiClient
  private run: Partial<NormalizedRun>
  private startedAt: Date

  constructor(runner: Mocha.Runner, options: { reporterOptions: ReporterOptions }) {
    super(runner, options)
    this.client = new ApiClient(options.reporterOptions)
    this.startedAt = new Date()
    this.run = { specs: [] }

    runner.on('suite', (suite) => {
      // spec file started
    })

    runner.on('pass', (test) => {
      this.addTest(test, 'passed')
    })

    runner.on('fail', (test, err) => {
      this.addTest(test, 'failed', err)
    })

    runner.on('pending', (test) => {
      this.addTest(test, 'skipped')
    })

    runner.on('end', async () => {
      await this.client.postRun({
        ...this.run,
        meta: {
          started_at: this.startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          branch: process.env.BRANCH_NAME ?? process.env.BITBUCKET_BRANCH ?? '',
          commit_sha: process.env.BITBUCKET_COMMIT ?? process.env.GITHUB_SHA ?? '',
          ci_run_id: process.env.BITBUCKET_BUILD_NUMBER ?? process.env.GITHUB_RUN_ID ?? '',
          suite_name: options.reporterOptions.suite,
          reporter: 'cypress',
        },
      })
    })
  }

  private addTest(test: Mocha.Test, status: NormalizedTest['status'], err?: Error) {
    // append to this.run.specs[...]
  }
}

module.exports = FlakeyCypressReporter
```

Cypress requires the reporter to be exported as `module.exports` (CommonJS).

---

## Playwright setup

Playwright has a first-class custom reporter interface with typed lifecycle hooks.

### playwright.config.ts

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: [
    ['@flakeytesting/playwright-reporter', {
      url: 'https://your-flakey-instance.com',
      token: process.env.FLAKEY_TOKEN,
      suite: 'playwright-suite',
      project: 'encor-tests',
    }]
  ],
})
```

### How it works internally (playwright-reporter.ts)

```ts
import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter'
import { ApiClient } from './api-client'
import { NormalizedRun } from './schema'

export default class FlakeyPlaywrightReporter implements Reporter {
  private client: ApiClient
  private run: Partial<NormalizedRun>
  private startedAt: Date

  constructor(options: ReporterOptions) {
    this.client = new ApiClient(options)
    this.startedAt = new Date()
    this.run = { specs: [] }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    // map test + result → NormalizedTest and append to this.run
    const status = result.status === 'passed' ? 'passed'
      : result.status === 'failed' ? 'failed'
      : result.status === 'skipped' ? 'skipped'
      : 'pending'

    // screenshots are in result.attachments
    const screenshots = result.attachments
      .filter(a => a.contentType === 'image/png')
      .map(a => a.path ?? '')
  }

  async onEnd(result: FullResult) {
    await this.client.postRun({
      ...this.run,
      meta: {
        started_at: this.startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        branch: process.env.BRANCH_NAME ?? process.env.GITHUB_REF_NAME ?? '',
        commit_sha: process.env.GITHUB_SHA ?? '',
        ci_run_id: process.env.GITHUB_RUN_ID ?? '',
        suite_name: this.options.suite,
        reporter: 'playwright',
      },
    })
  }
}
```

Playwright reporters must be ES module default exports.

---

## WebdriverIO setup

WebdriverIO has a custom reporter interface with lifecycle hooks.

### wdio.conf.ts

```ts
import FlakeyReporter from '@flakeytesting/webdriverio-reporter'

export const config = {
  reporters: [[FlakeyReporter, {
    url: 'https://your-flakey-instance.com',
    apiKey: process.env.FLAKEY_API_KEY,
    suite: 'webdriverio-suite',
  }]],
}
```

---

## Shared API client (@flakeytesting/core — api-client.ts)

```ts
import { NormalizedRun } from './schema'

export class ApiClient {
  private url: string
  private token: string

  constructor(options: { url: string; token: string }) {
    this.url = options.url
    this.token = options.token
  }

  async postRun(run: NormalizedRun): Promise<void> {
    const res = await fetch(`${this.url}/api/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(run),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Flakey API error ${res.status}: ${text}`)
    }
  }
}
```

---

## package.json (example: cypress-reporter)

```json
{
  "name": "@flakeytesting/cypress-reporter",
  "version": "0.1.0",
  "description": "Cypress reporter for Flakey dashboard",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/cypress-reporter.cjs",
    "./plugin": "./dist/plugin.js",
    "./support": "./dist/support.js"
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "pnpm build"
  },
  "dependencies": {
    "@flakeytesting/core": "workspace:*"
  },
  "peerDependencies": {
    "cypress": ">=12.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "mocha": "^10.0.0"
  }
}
```

Each reporter package only has a peer dependency on its own framework.

---

## Why this is better than normalizing

| Approach | Pros | Cons |
|---|---|---|
| Post-run normalizer | Works with existing reporter configs | Extra step, relies on file output, format can change |
| @flakeytesting/*-reporter packages | Direct to API, no files, typed schema, real-time on `end` event | Teams must install and configure the package |

The normalizer approach (mochawesome/JUnit) is still worth keeping as a fallback
for teams that can't or won't change their reporter config. The `@flakeytesting/*-reporter`
packages are the first-class path for teams fully buying into Flakey.

---

## Publishing

```bash
# build
pnpm build

# publish to npm (public)
npm publish --access public

# each package is published separately, e.g.:
# cd packages/flakey-cypress-reporter && npm publish --access public
# cd packages/flakey-playwright-reporter && npm publish --access public
# cd packages/flakey-webdriverio-reporter && npm publish --access public
```

Once published, any team can install it and point it at their self-hosted Flakey instance.

---

## Updated architecture with reporter packages

```
Cypress / Playwright / WebdriverIO test run
        ↓
@flakeytesting/*-reporter intercepts lifecycle events
        ↓
Builds NormalizedRun in memory
        ↓
POST /api/runs on run end (no files written)
        ↓
Flakey API stores directly — no normalizer needed
        ↓
Svelte dashboard displays results
```
