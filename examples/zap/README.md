# Better Testing — OWASP ZAP example

Runs an OWASP ZAP API scan against a target URL and uploads findings to the
Better Testing dashboard as a JUnit test run.

## Prerequisites

- Docker (ZAP runs via the official `ghcr.io/zaproxy/zaproxy:stable` image)
- Node.js 18+ and pnpm
- `FLAKEY_API_KEY` set in your environment or in a local `.env` file
- `TARGET_URL` set to the OpenAPI spec URL of the system under test

```sh
cp .env.example .env   # then fill in FLAKEY_API_KEY and TARGET_URL
pnpm install
```

## Running

```sh
TARGET_URL=https://api.example.com/openapi.json pnpm test:api
```

The command does three things in sequence:

1. `docker run ... zap-api-scan.py` — scans `$TARGET_URL`, writes
   `zap-report.json` and `zap-report.xml`
2. `node scripts/convert.js` — converts the ZAP JSON report to JUnit XML at
   `results/zap-results.xml` (each alert becomes a test case; risk ≥ 1 is a
   failure)
3. `node scripts/upload.js` — uploads `results/zap-results.xml` as a JUnit
   run via `@flakeytesting/cli`, then forwards the raw `zap-report.json` to
   `POST /security` so the dashboard renders normalized findings (severity
   rollup, per-rule deduplication, raw payload retained for forensics)

### Linking to a release

```sh
FLAKEY_RELEASE=v1.2.0 TARGET_URL=https://api.example.com/openapi.json pnpm test:api
```

## Features exercised

| Feature | How |
|---|---|
| Security scan ingestion | ZAP JSON → JUnit XML (via `scripts/convert.js`) → uploaded to `/runs` as a standard JUnit test run. Each ZAP alert appears as a test case in the dashboard |
| Native findings endpoint | `scripts/upload.js` then POSTs the raw `zap-report.json` to `/security`, which normalizes alerts into severity buckets (high / medium / low / info) and stores the raw payload for forensics |
| Findings retention | The backend stores both the JUnit payload (per-alert pass/fail) and the raw ZAP report on `security_scans.raw_report` |
| Release linking | Set `FLAKEY_RELEASE=<tag>` to associate the scan with a release; stored on the run record |
| Flaky/intermittent alert tracking | Re-running the scan periodically lets Better Testing surface alerts that appear and disappear across runs |

## rules.tsv

`rules.tsv` is passed to ZAP as a scan-policy override file (`-c rules.tsv`).
Each row has three columns:

```
<rule-id>  <action>  <reason>
```

| Action | Meaning |
|---|---|
| `IGNORE` | Suppress this alert — it will not appear in the report |
| `WARN` | Downgrade to warning (not a failure) |
| `FAIL` | Escalate to failure regardless of risk level |

The bundled `rules.tsv` currently ignores two rules that produce false
positives against API-only targets:

- **10003** — Vulnerable JS Library (irrelevant for non-HTML APIs)
- **10015** — Re-examine Cache-control Directives (API response caching is
  intentional)

Add rows for any other rules that are noise for your target.

## Demo: scanning a deliberately vulnerable target

To see Better Testing surface real findings, point the scan at a publicly
available vulnerable application.  **Do not enable this in CI** — it is
for local demo purposes only.

In `package.json`, temporarily replace `$TARGET_URL` with a known-vulnerable
OpenAPI endpoint, for example the OWASP Juice Shop:

```jsonc
// package.json — demo only, do NOT commit with this value
"test:api": "docker run --rm -v $(pwd):/zap/wrk ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py -t https://juice-shop.herokuapp.com/api-docs/ -f openapi -J /zap/wrk/zap-report.json -x /zap/wrk/zap-report.xml -c /zap/wrk/rules.tsv || true; node scripts/convert.js; node scripts/upload.js api"
```

Revert to `$TARGET_URL` before committing.

## env vars

| Variable | Required | Description |
|---|---|---|
| `FLAKEY_API_KEY` | yes | API key for the Better Testing backend |
| `TARGET_URL` | yes | OpenAPI spec URL to scan |
| `FLAKEY_API_URL` | no | Backend URL (default: `http://localhost:3000`) |
| `FLAKEY_RELEASE` | no | Release tag to link the run to |
