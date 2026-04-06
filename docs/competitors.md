# Competitor comparison

## Feature matrix

| Feature | Cypress Cloud | Sorry Cypress | Currents.dev | ReportPortal | Allure TestOps | Your tool |
|---|---|---|---|---|---|---|
| **Reporting** | | | | | | |
| Pass/fail dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Historical trends | ✅ | ± | ✅ | ✅ | ✅ | ✅ |
| Flakiness detection | ✅ | ✗ | ✅ | ✅ | ✅ | ✅ |
| Screenshots on failure | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Video recording | ✅ | ± | ✅ | ✗ | ✗ | ✅ |
| Multi-reporter support | ✗ | ✗ | ✗ | ✅ | ± | ✅ |
| **Parallelization** | | | | | | |
| Live test orchestration | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ |
| CI-native parallel (matrix) | ± | ± | ± | ✗ | ✗ | ✅ |
| Real-time run progress | ✅ | ✅ | ✅ | ✗ | ± | ✗ |
| **Integration & hosting** | | | | | | |
| Self-hostable | ✗ | ✅ | ✗ | ✅ | ✗ | ✅ |
| No vendor lock-in | ✗ | ± | ✗ | ✅ | ✗ | ✅ |
| Works with any CI | ± | ± | ± | ✅ | ✅ | ✅ |
| Bitbucket Pipelines native | ± | ✗ | ± | ± | ✗ | ✅ |
| **Cost & access** | | | | | | |
| Free tier | ± | ✅ | ± | ✅ | ✗ | ✅ |
| No per-test pricing | ✗ | ✅ | ✗ | ✅ | ✗ | ✅ |
| Open source | ✗ | ✅ | ✗ | ✅ | ✗ | ✅ |

± = partial or limited support

## Tool profiles

### Cypress Cloud
The original. Deep Cypress integration, live orchestration, real-time dashboards. Expensive at scale (per-test pricing). Actively blocked third-party alternatives in v12/v13+ by detecting and erroring on competing dashboard libraries like `cypress-cloud`. No self-hosting option.

### Sorry Cypress
Open-source self-hosted alternative. Uses a fork/custom binary approach to get around Cypress's blocking. Requires running your own orchestration server (MongoDB, S3, API, dashboard). Good for teams that need live orchestration but don't want to pay for Cypress Cloud. Limited reporting features compared to paid options. No flakiness detection out of the box.

### Currents.dev
Paid cloud service, more affordable than Cypress Cloud. Uses forked Cypress binaries to work around blocking. Good feature set but still vendor lock-in and per-test pricing at higher tiers. Better Bitbucket support than Sorry Cypress.

### ReportPortal
Open-source, self-hostable, framework-agnostic reporting platform. Supports many reporters and frameworks. Heavy to self-host (requires Elasticsearch, RabbitMQ, PostgreSQL). Not Cypress-specific so lacks screenshot/video handling out of the box. Best-in-class for large enterprise multi-framework testing setups.

### Allure TestOps
Paid platform built around the Allure report format. Strong reporting and analytics. No self-hosting on the commercial version. Requires Allure-specific reporters which adds friction for Cypress teams.

## Key differentiators for your tool

1. **Multi-reporter normalizer** — the only tool in this list (other than ReportPortal) that accepts multiple report formats via a normalizer layer
2. **CI-native parallelization** — works with Bitbucket parallel steps and GitHub Actions matrix out of the box, no orchestration server needed
3. **No Cypress dependency** — any framework that outputs mochawesome or JUnit can use it
4. **Genuinely simple to self-host** — no Elasticsearch, no RabbitMQ, just PostgreSQL + Node + Svelte
