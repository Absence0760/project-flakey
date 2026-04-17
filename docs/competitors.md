# Competitor comparison

## Feature matrix

| Feature | Cypress Cloud | Sorry Cypress | Currents.dev | ReportPortal | Allure TestOps | Tesults | BuildPulse | Launchable | Better Testing |
|---|---|---|---|---|---|---|---|---|---|
| **Reporting** | | | | | | | | | |
| Pass/fail dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Historical trends | ✅ | ± | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Flakiness detection | ✅ | ✗ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Screenshots on failure | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ | ✅ |
| Video recording | ✅ | ± | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Multi-reporter support | ✗ | ✗ | ± | ✅ | ± | ✅ | ✅ | ✅ | ✅ |
| **AI / ML** | | | | | | | | | |
| AI failure classification | ✅ | ✗ | ✗ | ✅ | ✗ | ± | ± | ✅ | ✅ |
| AI error summaries | ✅ | ✗ | ✗ | ✗ | ✗ | ± | ✗ | ✗ | ✅ |
| Predictive test selection | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ | ✅ |
| Flaky test quarantining | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✅ | ✅ | ✅ |
| AI coding agent (MCP) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Local AI model support | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| **CI/PR integration** | | | | | | | | | |
| GitHub PR status checks | ✅ | ✗ | ✅ | ✗ | ✅ | ✅ | ✅ | ✗ | ✅ |
| GitHub PR comments | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✅ | ✗ | ✅ |
| GitLab MR integration | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✅ |
| Bitbucket PR integration | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Jira integration | ✅ | ✗ | ✅ | ✅ | ✅ | ✅ | ✅ | ✗ | ✗ |
| Scheduled reports | ✗ | ✗ | ✅ | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ |
| **Parallelization** | | | | | | | | | |
| Live test orchestration | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Smart spec balancing | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| CI-native parallel (matrix) | ± | ± | ± | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Parallel run merging | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| Real-time run progress | ✅ | ✅ | ✅ | ✗ | ± | ✗ | ✗ | ✗ | ✅ |
| Auto-cancellation | ✅ | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ |
| **Extended testing** | | | | | | | | | |
| Code coverage tracking | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ |
| Accessibility testing | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| UI coverage mapping | ✅ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Visual regression testing | ✗ | ✗ | ± | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Manual test management | ✗ | ✗ | ✗ | ± | ✅ | ✅ | ✗ | ✗ | ✗ |
| **Integration & hosting** | | | | | | | | | |
| Self-hostable | ✗ | ✅ | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ |
| No vendor lock-in | ✗ | ± | ✗ | ✅ | ✗ | ± | ± | ± | ✅ |
| Works with any CI | ± | ± | ± | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bitbucket Pipelines native | ± | ✗ | ± | ± | ✗ | ✗ | ± | ✗ | ✅ |
| **Cost & access** | | | | | | | | | |
| Free tier | ± | ✅ | ± | ✅ | ✗ | ✅ | ± | ± | ✅ |
| No per-test pricing | ✗ | ✅ | ✗ | ✅ | ✗ | ± | ✗ | ✗ | ✅ |
| Open source | ✗ | ✅ | ✗ | ✅ | ✗ | ✗ | ✗ | ✗ | ✅ |

± = partial or limited support

## Tool profiles

### Cypress Cloud
The original. Deep Cypress integration, live orchestration, real-time dashboards. Expensive at scale (per-test pricing). Actively blocked third-party alternatives in v12/v13+ by detecting and erroring on competing dashboard libraries like `cypress-cloud`. No self-hosting option.

### Sorry Cypress
Open-source self-hosted alternative. Uses a fork/custom binary approach to get around Cypress's blocking. Requires running your own orchestration server (MongoDB, S3, API, dashboard). Good for teams that need live orchestration but don't want to pay for Cypress Cloud. Limited reporting features compared to paid options. No flakiness detection out of the box.

### Currents.dev
Paid cloud service, more affordable than Cypress Cloud (~2-2.5x cheaper). Supports both Playwright and Cypress. Intelligent load balancing, crash-resilient reporting (streams partial results even if CI containers crash), flaky test quarantining, GitHub PR comments, Jira auto-ticket creation, scheduled report generation, and rule-based automation. Also offers an MCP server for AI agent integration. Still vendor lock-in and per-test pricing at higher tiers.

### ReportPortal
Open-source, self-hostable, framework-agnostic reporting platform. Supports 30+ reporters and frameworks. Heavy to self-host (requires Elasticsearch, RabbitMQ, PostgreSQL). Best-in-class ML-powered failure analysis: auto-classifies failures by type (product bug, automation bug, system issue), surfaces historically similar failures, and detects patterns with predictive insights. "Unique Error" feature groups identical failures for bulk triage. Evolving into a full Test Management System in 2026. Integrates with Jira, Rally, Bugzilla, Trello, Azure DevOps.

### Allure TestOps
Paid platform built around the Allure report format. Key differentiator is unified manual + automated test management with "Smart Test Cases" that auto-update documentation based on run results. Offers a proprietary Allure Query Language (AQL) for building custom KPI dashboards. Two-way CI/CD integration (can trigger CI jobs from TestOps and vice versa). Supports 100+ testing frameworks. Scales to 1M+ test cases. Cloud and on-premise deployment options. No self-hosting on the free tier.

### Tesults
Test results reporting with built-in case management. Turns test failures into team assignments and supports release checklists with sign-off workflows. Only competitor with PagerDuty integration for triggering incidents from test failures. Offers a mobile app for iOS/Android. SSO included on all plans including Free. Fair billing model that charges per active user only. Integrates with Slack, Teams, Mattermost, and Jira.

### BuildPulse
Focused on flaky test detection and CI optimization. Core feature is flaky test quarantining — automatically isolates flaky tests so they don't block CI. Offers code coverage tracking with PR gating and blind spot detection. "BuildPulse Runners" execute CI jobs at 2x performance and 50% cost reduction. Supports monorepo segmentation by team/environment/service. PR bot comments when builds fail due to flakiness. Integrates with Jira, Linear, GitHub Issues, and Slack.

### Launchable (now CloudBees Smart Tests)
ML-powered predictive test selection — the core differentiator. Analyzes code changes + test history to predict which tests will fail, selecting only relevant tests per change. Claims 90% of failures caught in 20% of test time. Also provides AI failure classification and intelligent test scheduling. Acquired by CloudBees and integrated into their CI/CD platform. Framework-agnostic. Strongest claims on CI cost savings (3-5 cloud instances saved per test hour).

## Key differentiators for Better Testing

1. **Multi-reporter normalizer** — accepts Mochawesome, JUnit XML, and Playwright JSON via a normalizer layer
2. **CI-native parallelization** — works with Bitbucket parallel steps and GitHub Actions matrix out of the box, no orchestration server needed
3. **No Cypress dependency** — any framework that outputs mochawesome, JUnit, or Playwright JSON can use it
4. **Genuinely simple to self-host** — no Elasticsearch, no RabbitMQ, just PostgreSQL + Node + Svelte
5. **Free and open source** — no per-test pricing, no vendor lock-in, MIT licensed

## Biggest competitive gaps

These are the most impactful features competitors offer that Better Testing does not yet have (see roadmap Phases 7-10):

1. **GitHub PR status checks and comments** (Cypress Cloud, Currents, BuildPulse) — most teams expect test results surfaced directly in PRs
2. **AI/ML failure analysis** (ReportPortal, Launchable, Cypress Cloud) — auto-classify failures, surface similar historical failures, generate root cause summaries
3. **Flaky test quarantining** (Currents, BuildPulse, Launchable) — isolate flaky tests from blocking CI without removing them from the suite
4. **Jira integration** (Cypress Cloud, Currents, ReportPortal, Allure, Tesults, BuildPulse) — auto-create tickets from test failures
5. **Predictive test selection** (Launchable) — ML picks which tests to run based on code changes, cutting test time dramatically
6. **Code coverage tracking** (BuildPulse) — coverage metrics with PR gating
