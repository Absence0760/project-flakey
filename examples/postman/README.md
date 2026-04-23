# Better Testing — Postman example

Runs a Postman collection via Newman against the Better Testing backend and
uploads results + API endpoint coverage.

## Prerequisites

- Node.js 18+
- pnpm
- `FLAKEY_API_KEY` set in your environment or in a local `.env` file

```sh
cp .env.example .env   # then fill in FLAKEY_API_KEY
pnpm install
```

## Running

```sh
# Run the collection, generate coverage summary, and upload results
pnpm test:smoke

# Upload coverage to a specific run (set FLAKEY_RUN_ID first)
FLAKEY_RUN_ID=42 pnpm coverage:upload
```

### Linking to a release

Set `FLAKEY_RELEASE` to tag this run in the dashboard:

```sh
FLAKEY_RELEASE=v1.2.0 pnpm test:smoke
```

## Features exercised

| Feature | How |
|---|---|
| API testing via Newman + JUnit upload | Newman runs `collection.json`, emits `reports/results.xml` (JUnit format), then `scripts/upload.js` forwards it to the backend via `@flakeytesting/cli` |
| Flaky-test detection | The **Flaky** folder in `collection.json` contains a request with an intentional ~30% failure (`Math.random() < 0.3`). Run `test:smoke` repeatedly and watch Better Testing surface the instability |
| API endpoint coverage metric | `scripts/generate-coverage.js` parses the JUnit XML after Newman exits, counts assertion pass/fail per endpoint, and writes two files: `coverage/api-coverage-summary.json` (human-readable) and `coverage/coverage-summary.json` (Istanbul-shaped, consumed by `flakey-upload coverage`) |
| Coverage upload | `pnpm coverage:upload` (or `FLAKEY_RUN_ID=<id> pnpm coverage:upload`) calls `flakey-upload coverage --run-id <id> --file coverage/coverage-summary.json`. Because the backend expects an Istanbul `coverage-summary.json`, the generator maps _endpoint assertions_ to Istanbul's `lines`/`statements`/`functions`/`branches` fields — all four carry the same endpoint-covered/total numbers |
| Release linking | Set `FLAKEY_RELEASE=<tag>` before running `test:smoke`; the value is passed to the CLI via `--release` and stored with the run |

## Coverage format note

The backend's `/coverage` endpoint expects the Istanbul `coverage-summary.json`
schema (`total.lines.pct`, `total.statements.pct`, etc.).  There is no native
Istanbul source for a Postman collection, so `generate-coverage.js` normalises
endpoint-assertion counts into that schema.  A "line" maps to one Postman
assertion; "covered" means the assertion passed.

## env vars

| Variable | Required | Description |
|---|---|---|
| `FLAKEY_API_KEY` | yes | API key for the Better Testing backend |
| `FLAKEY_API_URL` | no | Backend URL (default: `http://localhost:3000`) |
| `FLAKEY_RELEASE` | no | Release tag to link the run to |
| `FLAKEY_RUN_ID` | for `coverage:upload` | Run ID returned after `test:smoke` upload |
