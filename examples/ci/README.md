# CI integration examples — Better Testing

Copy-paste workflow templates for the three major CI providers. Each template shows:

1. Running a test suite (Cypress or Jest)
2. Uploading results to Better Testing via `flakey-upload`
3. Automatic PR/MR status and comment posting

The templates are in the subdirectory for each provider. Copy the relevant file into your repo and fill in the marked variables.

## Structure

```
examples/ci/
  github-actions/
    workflow.yml          — GitHub Actions workflow template
  gitlab/
    .gitlab-ci.yml        — GitLab CI template
  bitbucket/
    bitbucket-pipelines.yml — Bitbucket Pipelines template
```

## Required environment variables

All three providers need the same two variables:

| Variable | Where to set it | Description |
|---|---|---|
| `FLAKEY_API_KEY` | CI secret / repo variable | Better Testing API key (Profile > API Keys) |
| `FLAKEY_API_URL` | CI secret / repo variable | Backend URL, e.g. `https://bt.yourcompany.com` |

CI metadata is passed as standard environment variables. The templates show the provider-specific names for branch, commit SHA, and run/build ID.

## How PR/MR integration works

After `flakey-upload` completes, the Better Testing backend automatically:

1. Finds the PR/MR for the current commit (by SHA then by branch name)
2. Posts or updates a comment summarising: pass rate, failure count, flaky tests detected, coverage delta, and a link to the full run
3. Posts a commit status (`success` / `failure` / `pending`) with a link to the run

This is driven by the git-provider adapters in `backend/src/git-providers/`. The workflow for each provider is:

### GitHub

- Uses the GitHub REST API v3 (`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`)
- Finds open PR: `GET /repos/{owner}/{repo}/commits/{sha}/pulls`
- Posts comment: `POST /repos/{owner}/{repo}/issues/{pr_number}/comments`
- Updates comment: `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`
- Posts commit status: `POST /repos/{owner}/{repo}/statuses/{sha}`
  - States: `success`, `failure`, `pending` (GitHub's native states)

Configure in Better Testing: **Settings > Integrations > GitHub**. Required token scope: `repo` (for private repos) or `public_repo` (for public repos), plus `statuses:write`.

### GitLab

- Uses the GitLab REST API v4 (`PRIVATE-TOKEN` header)
- Finds open MR: `GET /projects/{id}/repository/commits/{sha}/merge_requests`
- Posts note: `POST /projects/{id}/merge_requests/{iid}/notes`
- Updates note: `PUT /projects/{id}/merge_requests/{iid}/notes/{note_id}`
- Posts commit status: `POST /projects/{id}/statuses/{sha}`
  - States: `success`, `failed`, `pending` (mapped from Better Testing's states)

Configure in Better Testing: **Settings > Integrations > GitLab**. Required token scope: `api`.

### Bitbucket

- Uses the Bitbucket REST API 2.0 (`Authorization: Bearer`)
- Finds open PR: `GET /repositories/{workspace}/{repo}/commit/{sha}/pullrequests`
- Posts comment: `POST /repositories/{workspace}/{repo}/pullrequests/{id}/comments`
- Updates comment: `PUT /repositories/{workspace}/{repo}/pullrequests/{id}/comments/{comment_id}`
- Posts build status: `POST /repositories/{workspace}/{repo}/commit/{sha}/statuses/build`
  - States: `SUCCESSFUL`, `FAILED`, `INPROGRESS` (Bitbucket's native states)

Configure in Better Testing: **Settings > Integrations > Bitbucket**. Required OAuth consumer scopes: `pullrequest:write`, `repository`.

## How upload works

### Frameworks with native reporters (Cypress, Playwright, WebdriverIO)

The `@flakeytesting/*-reporter` package uploads results automatically at the end of the run. No separate upload step is needed — just set `FLAKEY_API_KEY` and `FLAKEY_API_URL` in the environment.

### Frameworks using the CLI (Jest, Selenium, Postman, ZAP)

Run the test suite → the suite writes a report file (JUnit XML, Mochawesome JSON) → the `flakey-upload` CLI posts it to the backend:

```bash
# JUnit XML (Jest with jest-junit, or Postman/Newman)
npx flakey-upload \
  --reporter junit \
  --report-dir reports \
  --suite my-suite-name \
  --branch "$BRANCH" \
  --commit "$COMMIT_SHA" \
  --ci-run-id "$CI_RUN_ID" \
  --api-key "$FLAKEY_API_KEY"

# Mochawesome JSON (Selenium/Mocha)
npx flakey-upload \
  --reporter mochawesome \
  --report-dir reports \
  --suite my-suite-name \
  --api-key "$FLAKEY_API_KEY"
```

The CLI reads `FLAKEY_API_URL` from the environment (default: `http://localhost:3000`).

## What the PR comment looks like

```
## Better Testing results — jest-example-smoke

| | Count |
|---|---|
| Passed | 22 |
| Failed | 0 |
| Flaky | 1 |

Coverage: lines 57% (+2%)

[View full run →](https://bt.yourcompany.com/runs/42)
```

The comment is posted once and updated on subsequent pushes to the same PR — it does not accumulate.
