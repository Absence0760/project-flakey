# Backend audit

## High — docs contradict reality or tests have false positives

- [ ] **`testing.md` says `DB_USER` defaults to `flakey`, code defaults to `flakey_app`.**
  File: `backend/docs/testing.md:79` (table row) and `backend/src/db.ts:6`.
  Evidence — `db.ts`: `user: process.env.DB_USER ?? "flakey_app"`. Evidence — `testing.md`: `| DB_USER | flakey |`.
  Fix: change the table row to `| DB_USER | flakey_app |` and update the CI YAML example on line 118 from `DB_USER: flakey` to `DB_USER: flakey_app`. Also applies to `DB_PASSWORD`: `db.ts:7` defaults to `"flakey_app"` but `testing.md` says the default is `flakey`.

- [ ] **`testing.md` expected output block claims `tests 9 / pass 9` but the file now has 19 tests.**
  File: `backend/docs/testing.md:51-53`.
  The smoke test (`phase_9_10.smoke.test.ts`) has 19 `test(...)` blocks; `crypto.test.ts` has 7 more. Total run by `npm test` is 26. The stale output block misleads a developer running tests for the first time into thinking a pass is wrong.
  Fix: update the block to reflect actual counts, or replace it with a representative excerpt and note that counts change as tests are added.

- [ ] **`testing.md:26` and throughout instructs `pnpm test` / `pnpm install`; backend uses npm.**
  Files: `backend/docs/testing.md:26`, `91`, `116`; `backend/package.json` (npm lockfile, no pnpm workspace membership).
  `CLAUDE.md:15` explicitly says "Use **npm** here, not pnpm." The testing doc contradicts this three times, including in the CI YAML snippet (`cd backend && pnpm install && pnpm test`).
  Fix: replace all three occurrences with `npm test` / `npm install`.

- [ ] **`integrations.md:39` uses `pnpm dev` in a key-generation example; backend is npm-only.**
  File: `backend/docs/integrations.md:39`.
  Evidence: `FLAKEY_ENCRYPTION_KEY="$(openssl rand -base64 32)" pnpm dev`
  Fix: `FLAKEY_ENCRYPTION_KEY="$(openssl rand -base64 32)" npm run dev`

## Medium — stale, ambiguous, missing coverage

- [ ] **`CLAUDE.md` Commands section omits `rotate-keys`.**
  File: `backend/CLAUDE.md:7-11` (Commands list); `backend/package.json:9`.
  `package.json` has `"rotate-keys": "tsx src/scripts/rotate-encryption-keys.ts"`. CLAUDE.md lists `dev`, `seed`, `build`, `start`, `test` but not `rotate-keys`. Any Claude session working on encryption won't know the script exists.
  Fix: add `- \`npm run rotate-keys\` — re-encrypt all org secrets under the current primary key (see \`docs/integrations.md\` for rotation procedure)` to the Commands list.

- [ ] **`CLAUDE.md` normalizers list is incomplete — omits Jest and WebdriverIO.**
  File: `backend/CLAUDE.md:28`.
  The Layout section says `src/normalizers/` contains "Mochawesome, JUnit, Playwright, Jest, WebdriverIO" but CLAUDE.md only lists "Mochawesome, JUnit, Playwright, Jest, WebdriverIO" — actually on inspection the CLAUDE.md text at line 28 reads only `(Mochawesome, JUnit, Playwright, Jest, WebdriverIO)` which is correct. **Checked, accurate.**

- [ ] **`testing.md` "What each test covers" table covers only 9 tests; 10 additional tests added since then have no documentation.**
  File: `backend/docs/testing.md:60-70`.
  The table ends at "release checklist + sign-off enforcement". The following tests are unmentioned: manual test groups / bulk-link, release sessions (create / record / accept / auto-complete), requirements traceability, live run abort (explicit), live run abort (stale timeout), aborted flag on `/runs`, snapshot endpoint, idempotent upsert, pending→passed transition, upload-over-live-spec merge.
  Fix: extend the table with one row per new test, following the existing format. This is the primary reference for what the suite exercises.

- [ ] **`migrations.md` table is missing `030_tests_pending_unique.sql`.**
  File: `backend/docs/migrations.md:86-117`; migration exists at `backend/migrations/030_tests_pending_unique.sql`.
  The table stops at 029. Migration 030 adds `uniq_specs_run_file`, which is explicitly referenced in the smoke test comment at `phase_9_10.smoke.test.ts:819` and in `runs.ts:44`. Any developer reading migrations.md to understand the schema will have an incomplete picture.
  Fix: add `| \`030_tests_pending_unique.sql\` | Unique index on \`(run_id, file_path)\` for specs; prevents duplicate spec rows when a live run and a reporter upload race |` to the table.

- [ ] **`testing.md` "Adding more tests" section still says `pnpm test` (line 91) and the glob comment references it as `pnpm test` instead of `npm test`.**
  Covered by the High item above, but also: the prose at line 95 says "Extend `phase_9_10.smoke.test.ts`... (fastest)" while the file is now 887 lines and has 19 tests, making "extend this file" reasonable advice only if a new test fits the shared-state pattern. The advice is not wrong but could note that isolation via a separate file and port is preferred for tests needing clean state, which it does on lines 97-99. **Checked, adequate.**

## Low — style/context-window optimization

- [ ] **`CLAUDE.md` Layout section duplicates information that `ls src/` makes obvious.**
  File: `backend/CLAUDE.md:26-31`.
  The layout bullet list (`src/routes/`, `src/normalizers/`, etc.) adds no non-obvious information beyond directory names. The non-obvious facts — that `src/integrations/` covers the scheduler and `src/git-providers/` has PR-comment adapters — are worth keeping. The filler (`src/routes/ — Express route handlers`) can be dropped.
  Fix: collapse to a two-line note: `src/integrations/` — Jira, PagerDuty, scheduled reports, coverage-gate logic. `src/git-providers/` — GitHub/GitLab/Bitbucket PR-comment + commit-status adapters. Everything else is self-describing.

- [ ] **`CLAUDE.md` Email section restates what `EMAIL_FROM` already documents in-code.**
  File: `backend/CLAUDE.md:33-35`.
  The section says `Default EMAIL_FROM is Better Testing <noreply@example.com>`. That default is already in `email.ts:14`. The non-obvious fact — that SMTP is used for auth verification, password reset, *and* scheduled reports — is worth one line. The default value is not worth a section.
  Fix: merge into Key constraints as a single bullet: `SMTP_* + EMAIL_FROM control transactional mail (auth verification, password reset) and scheduled report delivery; all have safe defaults for local dev.`

- [ ] **`migrations.md:31` has a copy-paste in prose: "use `IF NOT EXISTS` / `IF NOT EXISTS` guards" (duplicated phrase).**
  File: `backend/docs/migrations.md:31` and `backend/docs/migrations.md:58`.
  Both occurrences read "Use `IF NOT EXISTS` / `IF NOT EXISTS` guards". The intent is "Use `IF NOT EXISTS` / `DO NOTHING` guards" or simply "Use `IF NOT EXISTS` guards".
  Fix: `Use \`IF NOT EXISTS\` guards so the migration is idempotent` (appears twice; fix both lines 31 and 58).
