# Flakey — Deploy Plan & Runbook

End-to-end plan for standing up and operating the AWS deployment under
[`infra/`](../../infra/). It complements [`infra/README.md`](../../infra/README.md)
(reference for each variable) and [`backup-and-dr.md`](./backup-and-dr.md)
(restore mechanics). This document is the *ordered procedure* — the sequence
that produces a seamless first deploy and the steady-state release loop after.

The stack: ECS Fargate (backend) + RDS Postgres + S3/CloudFront (frontend SPA),
fronted by an ALB, deployed from GitHub Actions via OIDC (no static AWS keys).

---

## 0. Why first deploys used to be bumpy (and what now smooths them)

Terraform registers the ECS task definition pointing at `<ecr-repo>:latest`, but
the ECR repo is **immutable** and the deploy workflow only ever pushes a
**per-SHA** tag — `:latest` is never pushed. On a clean account the first
`terraform apply` therefore creates a service with **no pullable image**: ECS
loops on `CannotPullContainerError` and the unhealthy-host alarm fires until the
first release runs. It self-heals, but the window is ugly and undocumented.

Two things close it:

- **[`infra/scripts/seed-first-image.sh`](../../infra/scripts/seed-first-image.sh)**
  (`pnpm infra:seed-image`) — builds and pushes the first backend image and rolls
  the service onto it, right after `terraform apply`. Run it once; from then on
  you deploy via releases.
- The ECS service now has a **deployment circuit breaker with rollback**
  (`infra/modules/ecs/main.tf`). A rollout whose tasks never go healthy
  auto-reverts to the last-good revision instead of hanging. `deploy.yml` then
  **asserts the live revision** post-wait, so a silent rollback turns the CI job
  red instead of falsely green.

---

## 1. Prerequisites (once per account)

| Need | Detail |
|---|---|
| AWS account + CLI auth | SSO or a profile with admin for the initial apply. `aws sts get-caller-identity` must work. |
| Terraform ≥ 1.5 | CI pins 1.13.0; local `tfenv` is fine. |
| Docker + buildx | For `seed-first-image.sh` (cross-builds the ARM64 image). |
| A domain | The ALB serves HTTPS only; you need DNS you control for the API and (optionally) the dashboard. |
| **ACM certs** | **ALB cert in the stack region** (`acm_certificate_arn`); **CloudFront cert in `us-east-1`** (`cloudfront_acm_certificate_arn`) if using a custom dashboard domain. Both must be **ISSUED** before apply — request + validate them first. |

> **Custom `app_name`?** Two things do *not* auto-follow a non-default
> `app_name` and must be handled explicitly — see [§7](#7-deploying-with-a-non-default-app_name). If you keep the default `flakey`, skip that section.

---

## 2. Bootstrap stack (state backend + OIDC deploy role)

```bash
cd infra/bootstrap
terraform init
terraform apply -var="github_repo=<your-org>/<your-repo>"
```

Creates: the Terraform state S3 bucket + DynamoDB lock table, and the GitHub
OIDC provider + deploy IAM role. Save the output:

```bash
terraform output github_actions_role_arn   # → GitHub secret AWS_ROLE_ARN
```

The deploy role's trust is pinned to `repo:<repo>:environment:production`, so it
is only assumable from jobs running in the `production` GitHub Environment
(created in [§5](#5-github-secrets--environment)).

---

## 3. Preflight

```bash
pnpm infra:preflight        # = infra/scripts/preflight.sh
```

Read-only gate: terraform fmt/validate (both stacks), AWS auth, required tfvars
present and placeholder-free, **ACM certs ISSUED and in the correct region**,
and (if `gh` is present) the deploy secrets. Fix every `FAIL` before applying.

---

## 4. Apply the main stack

Create `infra/terraform.tfvars` from `terraform.tfvars.example`. At minimum:

```hcl
acm_certificate_arn = "arn:aws:acm:<region>:<acct>:certificate/..."  # ALB cert, stack region
budget_alert_email  = "ops@your-domain.com"
csp_connect_src     = ["https://api.your-domain.com"]                # the API origin the SPA fetches

# Custom dashboard domain (optional but recommended for prod):
cloudfront_acm_certificate_arn = "arn:aws:acm:us-east-1:<acct>:certificate/..."
cloudfront_aliases             = ["app.your-domain.com"]
public_app_url                 = "https://app.your-domain.com"        # drives CORS_ORIGINS/FRONTEND_URL
```

> **`public_app_url` matters.** Without it, the backend's `CORS_ORIGINS` defaults
> to the `*.cloudfront.net` domain. If you serve the dashboard from a custom
> alias, the browser's `Origin` is that alias, every API fetch is CORS-blocked,
> and the dashboard renders blank. Set `public_app_url` to the same origin as
> your alias.

```bash
cd infra
terraform init
terraform plan      # review
terraform apply
```

Point DNS at the outputs: the API record (e.g. `api.your-domain.com`) → ALB
(`terraform output alb_dns_name`); the dashboard alias → CloudFront.

---

## 5. GitHub secrets + Environment

Create the **`production`** Environment (Settings → Environments) with a
**Required reviewers** rule — every deploy then waits for an operator to Approve.
Add these secrets (repo-level or, tighter, on the environment):

| Secret | Source |
|---|---|
| `AWS_ROLE_ARN` | `cd infra/bootstrap && terraform output github_actions_role_arn` |
| `API_URL` | `https://` + your API domain (the ALB origin). **Must be non-empty** — `deploy.yml` now fails the build if it's blank, since an empty value silently ships a dead dashboard. |
| `FRONTEND_BUCKET` | `terraform output frontend_bucket` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `terraform output cloudfront_distribution_id` |
| `SITE_URL` *(optional)* | Public marketing origin for canonical/OG tags. |

---

## 6. Seal the first deploy, then release

**First deploy** — seed the initial image so the service goes healthy:

```bash
pnpm infra:seed-image       # build + push first image, roll the service onto it
```

(Defaults to region `ap-southeast-2`, `app_name=flakey`, `environment=production`,
tag = current git short SHA. Override with `--region/--app-name/--environment/--tag`.)

**Steady state** — every subsequent deploy is a published GitHub release tagged
`app@<version>` (the `check-tag` gate requires the `app@` prefix):

```bash
gh release create app@1.2.3 --title "app@1.2.3" --notes "…"
```

`deploy.yml` then: builds + pushes the SHA-tagged ARM64 image → registers a new
task-def revision pointing at it → `update-service` → waits for stable →
**asserts the live revision is the new one** → builds the frontend (guarded
against an empty `API_URL`) → syncs to S3 → invalidates CloudFront.
`workflow_dispatch` runs the same path on demand.

Migrations run inside the backend container on boot (`backend/entrypoint.sh`),
**before** the app process — a failed migration aborts startup, the task never
goes healthy, and the circuit breaker rolls back. Deploying the image *is* the
migration; there is no separate migrate step.

---

## 7. Deploying with a non-default `app_name`

Two things do not follow `app_name` automatically:

1. **Terraform state backend** (`infra/versions.tf`) hard-codes
   `flakey-terraform-state` / `flakey-terraform-locks` — Terraform backend blocks
   can't use variables. Bootstrap creates `<app_name>-terraform-state`, so for a
   custom name, init the main stack with explicit backend config:

   ```bash
   terraform init \
     -backend-config="bucket=<app_name>-terraform-state" \
     -backend-config="dynamodb_table=<app_name>-terraform-locks"
   ```

2. **Deploy workflow resource names** — set repo-level **Actions variables**
   (not secrets): `ECR_BACKEND`, `ECS_CLUSTER`, `ECS_SERVICE_BACKEND`,
   `TASK_FAMILY`, and **`AWS_REGION`** if you deploy outside `ap-southeast-2`.
   Each is read as `${{ vars.X || '<default>' }}`.

The `Project` default-tag now tracks `var.app_name`, so the deploy role's
tag-scoped `cloudfront:CreateInvalidation` works for any `app_name`.

---

## 8. Rollback

- **Frontend** — re-sync the prior `frontend/build` to the bucket and invalidate
  `/*`. Clean and instant (S3 versioning is on).
- **Backend** — point the service at a prior task-def revision (still in ECS) or
  re-run a prior `app@` release; the old SHA images are retained in ECR (last 20
  per-SHA + last 10 `v*`). A crash-looping new rollout **auto-rolls-back** via the
  circuit breaker — no manual action needed, and the CI job goes red so you know.
- **Schema** — migrations are forward-only. Additive (expand/contract) releases
  roll back cleanly; a destructive migration needs a DB restore (see
  [backup-and-dr.md](./backup-and-dr.md)). Prefer expand/contract so most
  rollbacks are image-only.

> **Partial-deploy caveat.** Backend deploys before frontend. If the backend
> ships and the frontend sync fails, prod runs new-backend + old-frontend until
> you re-run. Safe when the API change is additive; reconcile by re-running the
> release if it wasn't.

---

## 9. Known open items (tracked, not blocking)

These came out of the infra audit sweep and are intentionally deferred — none
block a correct deploy:

- **Helm chart `chart/values.yaml` carries `jwtSecret: "change-me-in-production"`**
  — but it is **not** silently deployable. `chart/templates/_helpers.tpl`'s
  `flakey.validateValues` (invoked at the top of `deployment.yaml`) `fail`s the
  render when the default is left unchanged and no `auth.existingSecret` is set,
  and likewise requires `app.encryptionKey`. A naive `helm install` therefore
  aborts with a clear message rather than shipping a guessable key — the residual
  is cosmetic (a placeholder string in `values.yaml`); no action needed. The ECS
  path is unaffected (secrets are Secrets-Manager-generated).
- **`backend/src/retention.ts` has no advisory lock.** With >1 ECS task, the
  nightly retention pass can double-emit `error.autoclosed` / `quarantine.expired`
  webhooks. Fix: wrap in `pg_try_advisory_xact_lock` like `scheduled-reports.ts`
  and `audit-export.ts` already do. (App-layer, not infra.)
- **CloudFront without a custom cert can't pin a TLS floor** — it falls back to
  CloudFront's global default. Set `cloudfront_acm_certificate_arn` +
  `cloudfront_aliases` before prod to enforce `TLSv1.2_2021`.
- **`RegisterTaskDefinition`'s `ecs:cluster` IAM condition is a no-op** (AWS
  doesn't support that condition key for the action). Low blast-radius; the
  mutating actions that *do* support scoping are already scoped.

---

## Quick reference

| Step | Command |
|---|---|
| Bootstrap | `cd infra/bootstrap && terraform apply -var="github_repo=…"` |
| Preflight | `pnpm infra:preflight` |
| Apply | `cd infra && terraform init && terraform apply` |
| Seed first image | `pnpm infra:seed-image` |
| Release | `gh release create app@<version> …` |
| Rollback (auto) | circuit breaker reverts; CI goes red |
