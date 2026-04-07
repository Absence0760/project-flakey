# @flakeytesting/reporter — custom reporter package

## Concept

Instead of generating mochawesome/JUnit output and normalizing it afterwards,
`@flakeytesting/reporter` is a custom npm/pnpm package that plugs directly into Cypress
or Playwright and POSTs results to the Flakey API in the unified schema.

No intermediate files. No normalizer needed. One package, two frameworks.

---

## Package structure

```
@flakeytesting/reporter/
├── package.json
├── src/
│   ├── index.ts              # entry — auto-detects or exports named reporters
│   ├── cypress-reporter.ts   # Cypress-compatible reporter (Mocha-based)
│   ├── playwright-reporter.ts # Playwright-compatible reporter
│   ├── api-client.ts         # shared HTTP POST logic
│   └── schema.ts             # unified schema types (shared with Flakey API)
├── dist/                     # compiled output
└── README.md
```

---

## Installation

```bash
# npm
npm install --save-dev @flakeytesting/reporter

# pnpm
pnpm add -D @flakeytesting/reporter
```

---

## Cypress setup

Cypress uses Mocha under the hood. Custom reporters receive Mocha runner events.

### cypress.config.ts

```ts
import { defineConfig } from 'cypress'

export default defineConfig({
  reporter: '@flakeytesting/reporter/cypress',
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
    ['@flakeytesting/reporter/playwright', {
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

## Shared API client (api-client.ts)

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

## package.json

```json
{
  "name": "@flakeytesting/reporter",
  "version": "0.1.0",
  "description": "Cypress and Playwright reporter for Flakey dashboard",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./cypress": "./dist/cypress-reporter.js",
    "./playwright": "./dist/playwright-reporter.js"
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "pnpm build"
  },
  "peerDependencies": {
    "cypress": ">=12.0.0",
    "@playwright/test": ">=1.30.0"
  },
  "peerDependenciesMeta": {
    "cypress": { "optional": true },
    "@playwright/test": { "optional": true }
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "mocha": "^10.0.0",
    "@playwright/test": "^1.40.0"
  }
}
```

Both peer dependencies are optional so you only need whichever framework you use.

---

## Why this is better than normalizing

| Approach | Pros | Cons |
|---|---|---|
| Post-run normalizer | Works with existing reporter configs | Extra step, relies on file output, format can change |
| @flakeytesting/reporter package | Direct to API, no files, typed schema, real-time on `end` event | Teams must install and configure the package |

The normalizer approach (mochawesome/JUnit) is still worth keeping as a fallback
for teams that can't or won't change their reporter config. The `@flakeytesting/reporter`
package is the first-class path for teams fully buying into Flakey.

---

## Publishing

```bash
# build
pnpm build

# publish to npm (public)
npm publish --access public

# or scope it
# name: @flakeytesting/reporter
# npm publish --access public
```

Once published, any team can install it and point it at their self-hosted Flakey instance.

---

## Updated architecture with reporter package

```
Cypress / Playwright test run
        ↓
@flakeytesting/reporter intercepts lifecycle events
        ↓
Builds NormalizedRun in memory
        ↓
POST /api/runs on run end (no files written)
        ↓
Flakey API stores directly — no normalizer needed
        ↓
Svelte dashboard displays results
```
