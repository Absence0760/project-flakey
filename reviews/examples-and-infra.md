# Review: infra/ · chart/ · examples/ · docs/

## Scope
- Files reviewed: 306 (excluding node_modules, dist, .git)
- Focus: bugs, misconfigurations, bad flows — Terraform safety, secrets, ECS/Fargate, RDS, S3/CloudFront, Helm chart, example correctness
- Reviewer confidence: high — every file opened; all cross-references verified against the actual resource definitions

## Status sweep — applied vs. open

This review pre-dates several follow-up commits.  Status as of the latest
sweep (2026-05-04):

| # | Item | Status |
|---|---|---|
| H1 | ALB HTTPS listener + redirect | **Applied** — `infra/modules/ecs/main.tf` has both listeners; `acm_certificate_arn` wired |
| H2 | S3 frontend OAC + private bucket | **Applied** — bucket public-access blocked, OAC + scoped policy in place |
| H3 | Scoped IAM `iam:PassRole` + ECR | **Applied** — `infra/bootstrap/main.tf` PassRole limited to ECS roles, ECR limited to push/pull verbs |
| H4 | GitHub OIDC second thumbprint | **Applied** — both thumbprints listed |
| H5 | Real API keys in local `.env` | **User action required** — files are gitignored / not committed; user must revoke keys in dashboard and rotate |
| M1 | CloudFront → S3 over HTTP | **Applied** (subsumed by H2) |
| M2 | RDS `multi_az` hardcoded false | **Applied** — variable with default `true` |
| M3 | RDS `publicly_accessible` explicit | **Applied** |
| M4 | ECR lifecycle expiring tagged images | **Applied** — split into untagged-cleanup + keep-last-10-tagged rules |
| M5 | Unused `db_password` in ECS module | **Applied** — only `db_password_arn` is now passed |
| M6 | Helm migration job swallows SQL errors | **Applied** — bare `psql -v ON_ERROR_STOP=1 -q -f` |
| M7 | Helm migration container resource limits | **Applied** — requests/limits set |
| M8 | Helm default plaintext credentials | **Applied** — `flakey.validateValues` helper checks `auth.jwtSecret` and is invoked from `deployment.yaml`; `helm install` without `--set auth.jwtSecret=…` (or `auth.existingSecret`) now fails fast.  Bundled-postgres DB defaults stay as placeholders since they only apply to the demo path |
| M9 | GHA template setup-node before pnpm | **Applied** — `Install pnpm` step now runs first |
| M10 | SNS alerts topic without subscription | **Applied** — `aws_sns_topic_subscription.alerts_email` + `alert_email` variable wired from root |
| L1 | RDS SG `0.0.0.0/0` egress | **Applied (this commit)** — egress block removed; implicit deny-all stands in |
| L2 | Artifacts bucket no versioning | **Applied (this commit)** — versioning enabled, noncurrent expiry 30d |
| L3 | `.terraform.lock.hcl` in `.gitignore` | **Applied (this commit)** — removed from gitignore; user should `terraform init` and commit the lock file |
| L4 | Helm `tag: latest` + `IfNotPresent` | **Applied (this commit)** — flipped default `pullPolicy: Always` so `helm upgrade` actually re-pulls the image.  Less aggressive than requiring an explicit tag (which would break `helm install` without `--set`); users pinning a specific tag can override `pullPolicy: IfNotPresent` to restore cached-layer behavior |
| L5 | Postman script "Flakey" brand drift | **Applied (this commit)** |

Only **H5** remains open — it is local-machine state (gitignored `.env`
files containing live API keys) that I cannot rotate for you.  Revoke
the keys in the dashboard and replace the file contents with
placeholders to clear it.  Original sections retained below for
traceability.

---

## Priority: high

### H1. ALB HTTP listener forwards traffic instead of redirecting to HTTPS
- **File(s)**: `infra/modules/ecs/main.tf:155-164`
- **Category**: security
- **Problem**: The only ALB listener defined is on port 80 with `type = "forward"`. There is no HTTPS listener and no HTTP→HTTPS redirect. The ALB security group opens port 443 inbound (line 91) but nothing listens on it. All backend API traffic — including auth tokens and API keys — transits in plaintext between the user's browser and the ALB.
- **Evidence**:
  ```hcl
  resource "aws_lb_listener" "http" {
    load_balancer_arn = aws_lb.main.arn
    port              = 80
    protocol          = "HTTP"

    default_action {
      type             = "forward"
      target_group_arn = aws_lb_target_group.backend.arn
    }
  }
  ```
  There is no `aws_lb_listener` for port 443, no `aws_acm_certificate` resource, and no `redirect` action anywhere in the module.
- **Proposed change**:
  ```diff
  - resource "aws_lb_listener" "http" {
  -   load_balancer_arn = aws_lb.main.arn
  -   port              = 80
  -   protocol          = "HTTP"
  -   default_action {
  -     type             = "forward"
  -     target_group_arn = aws_lb_target_group.backend.arn
  -   }
  - }
  + resource "aws_lb_listener" "http" {
  +   load_balancer_arn = aws_lb.main.arn
  +   port              = 80
  +   protocol          = "HTTP"
  +   default_action {
  +     type = "redirect"
  +     redirect {
  +       port        = "443"
  +       protocol    = "HTTPS"
  +       status_code = "HTTP_301"
  +     }
  +   }
  + }
  +
  + resource "aws_lb_listener" "https" {
  +   load_balancer_arn = aws_lb.main.arn
  +   port              = 443
  +   protocol          = "HTTPS"
  +   ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  +   certificate_arn   = var.acm_certificate_arn
  +   default_action {
  +     type             = "forward"
  +     target_group_arn = aws_lb_target_group.backend.arn
  +   }
  + }
  ```
  Add `variable "acm_certificate_arn" { type = string }` to `infra/modules/ecs/variables.tf` and wire it from `infra/main.tf`. The ACM cert must be in the same region as the ALB (not required to be us-east-1 since this is not a CloudFront cert).
- **Risk if applied**: The ECS service `depends_on = [aws_lb_listener.http]` references the HTTP listener by name; update to `depends_on = [aws_lb_listener.https]` once the HTTPS listener exists. If no ACM cert is available in the target region yet, provision it first — it requires DNS or email validation before Terraform can complete.
- **Verification**: After `terraform apply`, `curl -I http://<alb-dns>/health` must return `301`. `curl -I https://<alb-dns>/health` (with SNI matching the cert domain) must return `200`.

---

### H2. S3 frontend bucket is publicly accessible with a `Principal: "*"` bucket policy — OAI created but never used
- **File(s)**: `infra/modules/s3/main.tf:48-69, 72`
- **Category**: security / misconfiguration
- **Problem**: The frontend bucket has `block_public_acls = false`, `block_public_policy = false`, and a bucket policy that grants `s3:GetObject` to `Principal: "*"`. An `aws_cloudfront_origin_access_identity` resource is created on line 72 but is never referenced anywhere — CloudFront uses `custom_origin_config` pointing to the S3 website endpoint instead. The combined effect is that the bucket is directly internet-accessible without going through CloudFront, bypassing any WAF or geo-restriction you might later add. Anyone can enumerate and fetch files directly from S3.
- **Evidence**:
  ```hcl
  resource "aws_s3_bucket_public_access_block" "frontend" {
    block_public_acls       = false
    block_public_policy     = false
    ignore_public_acls      = false
    restrict_public_buckets = false
  }

  resource "aws_s3_bucket_policy" "frontend" {
    policy = jsonencode({
      Statement = [{
        Principal = "*"
        Action    = "s3:GetObject"
      }]
    })
  }

  resource "aws_cloudfront_origin_access_identity" "frontend" {}  # created but never wired in
  ```
- **Proposed change**: Replace the public bucket + website endpoint approach with a private bucket served exclusively through CloudFront OAC (Origin Access Control, the current AWS recommendation over OAI):
  ```diff
  - resource "aws_s3_bucket_website_configuration" "frontend" { ... }

  - resource "aws_s3_bucket_public_access_block" "frontend" {
  -   block_public_acls       = false
  -   block_public_policy     = false
  -   ignore_public_acls      = false
  -   restrict_public_buckets = false
  - }

  - resource "aws_s3_bucket_policy" "frontend" {
  -   policy = jsonencode({ Statement = [{ Principal = "*" ... }] })
  - }

  - resource "aws_cloudfront_origin_access_identity" "frontend" {}

  + resource "aws_s3_bucket_public_access_block" "frontend" {
  +   block_public_acls       = true
  +   block_public_policy     = true
  +   ignore_public_acls      = true
  +   restrict_public_buckets = true
  + }

  + resource "aws_cloudfront_origin_access_control" "frontend" {
  +   name                              = "${var.app_name}-${var.environment}-oac"
  +   origin_access_control_origin_type = "s3"
  +   signing_behavior                  = "always"
  +   signing_protocol                  = "sigv4"
  + }

  + resource "aws_s3_bucket_policy" "frontend" {
  +   policy = jsonencode({
  +     Version = "2012-10-17"
  +     Statement = [{
  +       Effect    = "Allow"
  +       Principal = { Service = "cloudfront.amazonaws.com" }
  +       Action    = "s3:GetObject"
  +       Resource  = "${aws_s3_bucket.frontend.arn}/*"
  +       Condition = {
  +         StringEquals = {
  +           "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
  +         }
  +       }
  +     }]
  +   })
  + }
  ```
  In the CloudFront distribution, replace the `custom_origin_config` block with an S3 native origin: change `domain_name` from `aws_s3_bucket_website_configuration.frontend.website_endpoint` to `aws_s3_bucket.frontend.bucket_regional_domain_name`, remove `custom_origin_config`, and add `origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id`. The SPA `custom_error_response` blocks (404→200, 403→200) remain unchanged.
- **Risk if applied**: The existing `aws_cloudfront_origin_access_identity` resource will be destroyed (it is currently a no-op so no traffic depends on it). The S3 website endpoint URL will stop serving content. The deployment pipeline that syncs files to S3 and invalidates CloudFront continues to work unchanged. Plan carefully: `terraform apply` on a live distribution replaces the origin, causing a brief cache-miss period.
- **Verification**: After apply, `curl https://<bucket-name>.s3.amazonaws.com/index.html` must return `403 AccessDenied`. `curl https://<cloudfront-domain>/index.html` must return `200`.

---

### H3. GitHub Actions OIDC role uses `iam:PassRole` with `Resource: "*"`
- **File(s)**: `infra/bootstrap/main.tf:124-127`
- **Category**: security
- **Problem**: The GitHub Actions deployment role grants `iam:PassRole` on `Resource: "*"`. This allows any workflow that assumes this role to pass any IAM role in the account to any service — including roles with `AdministratorAccess`. Combined with the `ecr:*` on `Resource: "*"` (line 100), this role can escalate to full account control if an attacker can push a malicious workflow to the repo.
- **Evidence**:
  ```hcl
  {
    Effect   = "Allow"
    Action   = ["iam:PassRole"]
    Resource = "*"
  },
  {
    Effect   = "Allow"
    Action   = ["ecr:*"]
    Resource = "*"
  }
  ```
- **Proposed change**: Scope both to the specific resources CI actually needs:
  ```diff
  - { Effect = "Allow", Action = ["iam:PassRole"], Resource = "*" },
  - { Effect = "Allow", Action = ["ecr:*"], Resource = "*" },
  + {
  +   Effect   = "Allow"
  +   Action   = ["iam:PassRole"]
  +   Resource = [
  +     "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-production-ecs-execution",
  +     "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-production-ecs-task"
  +   ]
  + },
  + {
  +   Effect = "Allow"
  +   Action = [
  +     "ecr:GetAuthorizationToken",
  +     "ecr:BatchCheckLayerAvailability",
  +     "ecr:GetDownloadUrlForLayer",
  +     "ecr:BatchGetImage",
  +     "ecr:PutImage",
  +     "ecr:InitiateLayerUpload",
  +     "ecr:UploadLayerPart",
  +     "ecr:CompleteLayerUpload"
  +   ]
  +   Resource = "*"
  + },
  ```
  Add `data "aws_caller_identity" "current" {}` at the top of `bootstrap/main.tf`.
- **Risk if applied**: If the ECS role names drift from the naming convention, `ecs:UpdateService` calls that internally pass roles will fail. Confirm role names match before applying. `GetAuthorizationToken` genuinely requires `Resource: "*"` — that line is correct.
- **Verification**: Run a deploy workflow after apply. `aws iam simulate-principal-policy` with the role ARN and `iam:PassRole` against an unrelated role ARN must return `implicitDeny`.

---

### H4. GitHub OIDC thumbprint is stale — may break OIDC auth at any time
- **File(s)**: `infra/bootstrap/main.tf:67`
- **Category**: bug
- **Problem**: The `aws_iam_openid_connect_provider` for GitHub Actions uses a single thumbprint `1c58a3a8518e8759bf075b76b750d4f2df264fcd`. GitHub rotated their OIDC TLS certificates in 2023 and the new intermediate CA produces thumbprint `6938fd4d98bab03faadb97b34396831e3780aea1`. AWS validates the JWT against the thumbprint list; if only the old thumbprint is present and GitHub serves the new certificate, authentication fails with a cryptographic trust error and all CI deployments break.
- **Evidence**:
  ```hcl
  resource "aws_iam_openid_connect_provider" "github" {
    url             = "https://token.actions.githubusercontent.com"
    client_id_list  = ["sts.amazonaws.com"]
    thumbprint_list = ["1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
  }
  ```
- **Proposed change**:
  ```diff
  - thumbprint_list = ["1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
  + thumbprint_list = [
  +   "6938fd4d98bab03faadb97b34396831e3780aea1",
  +   "1c58a3a8518e8759bf075b76b750d4f2df264fcd"
  + ]
  ```
- **Risk if applied**: None — adding a thumbprint to the list is non-destructive. Existing sessions are unaffected.
- **Verification**: After `terraform apply`, trigger a GitHub Actions workflow that calls `aws sts get-caller-identity` using the OIDC role and confirm it succeeds.

---

### H5. Real API keys present in local `.env` files across five examples
- **File(s)**: `examples/cypress/.env:2`, `examples/cypress-cucumber/.env:2`, `examples/playwright/.env:2`, `examples/selenium/.env:2`, `examples/webdriverio/.env:2`
- **Category**: security
- **Problem**: Five `.env` files contain what appear to be live API keys (`fk_c40c9b0be989489047bf1b951dea88835daffc35c143ee6f` shared across cypress/cypress-cucumber/playwright/selenium, and `fk_07fc66ef6e67876a4de76b48a11084aff4b7a245b9625d7d` in webdriverio). These files are not tracked in git (the root `.gitignore` excludes `.env` globally) and have never been committed, so there is no historical leak via git history. However, the keys exist on disk and could be inadvertently exposed if anyone zips and shares the working directory, pushes a fork without the gitignore, or has the directory indexed by a tool that ignores gitignore. The `.env.example` files correctly use the placeholder `fk_your_key_here`.
- **Evidence**:
  ```
  # examples/cypress/.env (same key in cypress-cucumber, playwright, selenium)
  FLAKEY_API_KEY=fk_c40c9b0be989489047bf1b951dea88835daffc35c143ee6f

  # examples/webdriverio/.env
  FLAKEY_API_KEY=fk_07fc66ef6e67876a4de76b48a11084aff4b7a245b9625d7d
  ```
- **Proposed change**: Revoke both keys immediately via Profile > API Keys in the Better Testing dashboard. Then overwrite each file:
  ```diff
  - FLAKEY_API_KEY=fk_c40c9b0be989489047bf1b951dea88835daffc35c143ee6f
  + FLAKEY_API_KEY=fk_your_key_here
  ```
  Apply to all five `.env` files. No git commit is needed since these files are gitignored.
- **Risk if applied**: Local development relying on these keys will need new keys. Create fresh keys after revoking.
- **Verification**: `curl -H "Authorization: Bearer fk_c40c9b0be989489047bf1b951dea88835daffc35c143ee6f" http://localhost:3000/auth/me` must return `401` after revocation.

---

## Priority: medium

### M1. ALB CloudFront `origin_protocol_policy = "http-only"` — full chain is cleartext
- **File(s)**: `infra/modules/s3/main.tf:83-88`
- **Category**: security
- **Problem**: The CloudFront distribution talks to the S3 website endpoint over HTTP only (`origin_protocol_policy = "http-only"`). This is a secondary consequence of H2. Fixing H2 (switching to OAC + S3 native origin) eliminates this block entirely. Noted separately because if H2 is not fixed, this setting means data in transit between CloudFront edge nodes and the S3 origin is unencrypted.
- **Evidence**:
  ```hcl
  custom_origin_config {
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
  }
  ```
- **Proposed change**: Fix H2. The `custom_origin_config` block is removed when switching to the S3 native origin + OAC.
- **Risk if applied**: Covered by H2.
- **Verification**: Covered by H2 verification.

---

### M2. RDS `multi_az = false` hardcoded for a production deployment
- **File(s)**: `infra/modules/rds/main.tf:48`
- **Category**: misconfiguration
- **Problem**: RDS is explicitly single-AZ. The backend has autoscaling and deletion protection enabled — this is treated as a prod service. Any AZ failure or forced AWS maintenance reboot on the single AZ takes the entire application down with no automatic failover. The default `environment = "production"` in `variables.tf:9` makes this a live risk.
- **Evidence**:
  ```hcl
  multi_az = false
  ```
- **Proposed change**:
  ```diff
  - multi_az = false
  + multi_az = true
  ```
  If you need to support non-prod deployments cheaply, make it a variable:
  ```hcl
  variable "rds_multi_az" {
    description = "Enable Multi-AZ RDS. Recommended true for production."
    type        = bool
    default     = true
  }
  ```
  Wire `multi_az = var.rds_multi_az` in the module and document it in `terraform.tfvars.example`.
- **Risk if applied**: Enabling Multi-AZ on an existing single-AZ instance triggers an in-place conversion (typically a brief failover of under 60s during the next maintenance window). `db.t4g.micro` supports Multi-AZ; cost roughly doubles for the instance.
- **Verification**: `aws rds describe-db-instances --db-instance-identifier flakey-production` must show `"MultiAZ": true`.

---

### M3. RDS `publicly_accessible` not explicitly set — should be pinned to `false`
- **File(s)**: `infra/modules/rds/main.tf:28-51`
- **Category**: misconfiguration
- **Problem**: `publicly_accessible` is absent from the `aws_db_instance` block. The Terraform provider defaults this to `false`, which is correct. However, the absence means a future copy-paste or refactor that clones this block could omit the setting without a reviewable diff entry. For a prod database, this should be explicit.
- **Evidence**: No `publicly_accessible` attribute in `aws_db_instance.main`.
- **Proposed change**:
  ```diff
    vpc_security_group_ids = [aws_security_group.rds.id]
  + publicly_accessible    = false
  ```
- **Risk if applied**: None — this is already the effective value. `terraform plan` will show no changes.
- **Verification**: `terraform plan` after the change must produce an empty diff.

---

### M4. ECR lifecycle policy expires tagged release images after 10 total images
- **File(s)**: `infra/modules/ecr/main.tf:11-24`
- **Category**: bug
- **Problem**: The lifecycle rule uses `tagStatus: "any"`, which causes it to expire tagged images (e.g. `v1.2.0`, `v1.3.0`) once the repository holds more than 10 images. If a rollback is needed to a tagged version that was the 11th-oldest push, that image is gone and must be rebuilt from source. The ECS service hardcodes `:latest` (`infra/main.tf:53`), but named tags used for auditing or emergency rollbacks will be silently expired.
- **Evidence**:
  ```json
  {
    "selection": {
      "tagStatus":   "any",
      "countType":   "imageCountMoreThan",
      "countNumber": 10
    },
    "action": { "type": "expire" }
  }
  ```
- **Proposed change**:
  ```diff
  - rules = [{
  -   rulePriority = 1
  -   selection = {
  -     tagStatus   = "any"
  -     countType   = "imageCountMoreThan"
  -     countNumber = 10
  -   }
  -   action = { type = "expire" }
  - }]
  + rules = [
  +   {
  +     rulePriority = 1
  +     description  = "Expire untagged images beyond 20"
  +     selection = {
  +       tagStatus   = "untagged"
  +       countType   = "imageCountMoreThan"
  +       countNumber = 20
  +     }
  +     action = { type = "expire" }
  +   },
  +   {
  +     rulePriority = 2
  +     description  = "Keep last 10 semver-tagged releases"
  +     selection = {
  +       tagStatus        = "tagged"
  +       tagPatternList   = ["v*"]
  +       countType        = "imageCountMoreThan"
  +       countNumber      = 10
  +     }
  +     action = { type = "expire" }
  +   }
  + ]
  ```
- **Risk if applied**: Terraform replaces the lifecycle policy (not the repo). No images are deleted on apply — the new policy only fires on the next push that would trigger cleanup.
- **Verification**: Push 11 images with `v*` tags; confirm only the oldest one is expired. Push 21 untagged images; confirm the oldest untagged one is expired.

---

### M5. ECS module receives plaintext `db_password` variable that is never used — leaks into Terraform state
- **File(s)**: `infra/modules/ecs/variables.tf:13`, `infra/main.tf:61`
- **Category**: security / dead-code
- **Problem**: The ECS module declares `variable "db_password" { type = string; sensitive = true }` and root `main.tf` passes `module.secrets.db_password` (the raw generated password) into it. However, `var.db_password` is never referenced in `infra/modules/ecs/main.tf` — the task definition correctly uses `var.db_password_arn` for Secrets Manager injection. The plaintext password flows into the module's input and is recorded in Terraform state under `modules.ecs.db_password`. Anyone with state read access sees the password even though it serves no functional purpose here.
- **Evidence**:
  ```hcl
  # infra/main.tf:61
  db_password = module.secrets.db_password        # plaintext, passed but unused

  # infra/modules/ecs/variables.tf:13
  variable "db_password" { type = string; sensitive = true }

  # infra/modules/ecs/main.tf — zero occurrences of var.db_password
  ```
- **Proposed change**:
  ```diff
  # infra/main.tf — remove line 61
  - db_password        = module.secrets.db_password

  # infra/modules/ecs/variables.tf — remove the variable
  - variable "db_password" { type = string; sensitive = true }
  ```
- **Risk if applied**: None. The variable is unused. `terraform plan` after removal must produce no changes to any resource.
- **Verification**: `terraform plan` produces an empty diff after removing both lines.

---

### M6. Helm migration job silently ignores SQL errors — bad schema changes deploy successfully
- **File(s)**: `chart/templates/migration-job.yaml:40`
- **Category**: bug
- **Problem**: The migration loop runs `psql -v ON_ERROR_STOP=1` but the exit code is swallowed by `|| echo "Warning: ... (continuing)"`. `ON_ERROR_STOP=1` causes `psql` to exit non-zero on the first SQL error, but the `||` catches that exit and the loop continues. A failed migration — constraint violation, missing table, incompatible column rename — silently passes, the Job exits `0`, and Helm marks the pre-upgrade hook as succeeded. The backend then starts against a partially-migrated schema.
- **Evidence**:
  ```sh
  psql -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 || echo "  Warning: $(basename $f) had errors (continuing)"
  ```
- **Proposed change**:
  ```diff
  - psql -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 || echo "  Warning: $(basename $f) had errors (continuing)"
  + psql -v ON_ERROR_STOP=1 -q -f "$f"
  ```
  Remove the `|| echo` entirely. On SQL failure, psql exits non-zero, the pod restarts (up to `backoffLimit: 3`), and Helm marks the hook as failed — blocking the deployment. This is correct behavior.
- **Risk if applied**: Any migration that previously failed silently will now fail loudly and block the upgrade. If migration SQL files emit non-zero exit for benign reasons (e.g. a `NOTICE` that confuses psql), those files need to be fixed, not masked.
- **Verification**: Create a test migration with an intentional SQL syntax error. Run `helm upgrade`; the hook Job must fail, the upgrade must be blocked, and `kubectl get job` must show the backoff limit exhausted.

---

### M7. Helm migration job container has no resource limits
- **File(s)**: `chart/templates/migration-job.yaml:12-54`
- **Category**: misconfiguration
- **Problem**: The migration Job's container has no `resources` block. Without limits, the container has no CPU/memory cap and can starve the node's other workloads or get OOM-killed during large schema changes.
- **Evidence**: The `containers` spec in `migration-job.yaml` has no `resources:` field.
- **Proposed change**:
  ```diff
  containers:
    - name: migrate
      image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
  +   resources:
  +     requests:
  +       cpu: 100m
  +       memory: 128Mi
  +     limits:
  +       cpu: 500m
  +       memory: 256Mi
  ```
- **Risk if applied**: None at apply time. New Jobs will be resource-constrained.
- **Verification**: After next `helm upgrade`, `kubectl describe pod <migration-pod>` must show non-empty Limits/Requests.

---

### M8. Helm default values ship plaintext credentials with no install-time validation
- **File(s)**: `chart/values.yaml:49, 59, 62`
- **Category**: security
- **Problem**: `values.yaml` ships with `auth.jwtSecret: "change-me-in-production"`, `database.password: flakey_app`, and `database.migrationPassword: flakey`. A `helm install flakey . ` with no overrides produces a running but insecure deployment — the known JWT secret will sign valid tokens if not changed, and the known DB password matches the default schema setup.
- **Evidence**:
  ```yaml
  auth:
    jwtSecret: "change-me-in-production"
  database:
    password: flakey_app
    migrationPassword: flakey
  ```
- **Proposed change**: Add a validation guard in `_helpers.tpl` that `helm template` / `helm install` will enforce:
  ```diff
  # chart/templates/_helpers.tpl — add at top
  + {{- define "flakey.validateValues" -}}
  + {{- if and (not .Values.auth.existingSecret) (eq .Values.auth.jwtSecret "change-me-in-production") -}}
  + {{- fail "auth.jwtSecret must be changed from the default. Set auth.jwtSecret or auth.existingSecret." -}}
  + {{- end -}}
  + {{- end -}}
  ```
  Call `{{ include "flakey.validateValues" . }}` at the top of `deployment.yaml`.
- **Risk if applied**: `helm install` with default values will now fail with a clear error. Any CI pipeline or documentation example that did `helm install flakey .` without overrides will break — which is the intended behavior.
- **Verification**: `helm template . --set auth.jwtSecret=change-me-in-production` must error. `helm template . --set auth.jwtSecret=any-other-value` must succeed.

---

### M9. GitHub Actions template: `cache: pnpm` declared before `pnpm/action-setup` runs
- **File(s)**: `examples/ci/github-actions/workflow.yml:46-56`
- **Category**: bug
- **Problem**: `actions/setup-node@v4` is called with `cache: pnpm` before `pnpm/action-setup@v4` has run. `setup-node`'s pnpm cache handler requires `pnpm` to be in PATH to locate the store directory. When `pnpm` is not yet installed, the cache step either errors or silently skips. The `pnpm/action-setup` docs explicitly say to install pnpm before calling `setup-node` with `cache: pnpm`.
- **Evidence**:
  ```yaml
  - uses: actions/setup-node@v4
    with:
      node-version: 20
      cache: pnpm          # pnpm not yet in PATH

  - name: Install pnpm
    uses: pnpm/action-setup@v4
    with:
      version: 10
  ```
- **Proposed change**: Swap the two steps:
  ```diff
  + - name: Install pnpm
  +   uses: pnpm/action-setup@v4
  +   with:
  +     version: 10

    - uses: actions/setup-node@v4
      with:
        node-version: 20
        cache: pnpm

  - - name: Install pnpm
  -   uses: pnpm/action-setup@v4
  -   with:
  -     version: 10
  ```
- **Risk if applied**: None.
- **Verification**: Run the workflow twice. The second run must show a cache hit in the `Post setup-node` step.

---

### M10. SNS alerts topic has no subscription — CloudWatch alarms fire silently
- **File(s)**: `infra/modules/ecs/main.tf:269-271`
- **Category**: bug
- **Problem**: `aws_cloudwatch_metric_alarm.unhealthy_hosts` and `aws_cloudwatch_metric_alarm.high_5xx` both send notifications to `aws_sns_topic.alerts`, but there is no `aws_sns_topic_subscription` resource anywhere in the repo. The alarms will transition to ALARM state but no notification will be delivered to anyone.
- **Evidence**: A search of the entire `infra/` directory finds zero `aws_sns_topic_subscription` resources.
- **Proposed change**:
  ```diff
  # infra/modules/ecs/main.tf
  + resource "aws_sns_topic_subscription" "alerts_email" {
  +   topic_arn = aws_sns_topic.alerts.arn
  +   protocol  = "email"
  +   endpoint  = var.alert_email
  + }
  ```
  Add `variable "alert_email" { type = string }` to `infra/modules/ecs/variables.tf`. In `infra/main.tf`, wire `alert_email = var.budget_alert_email` (reuse the existing variable, or add a separate one).
- **Risk if applied**: The first `terraform apply` creates the subscription but it requires a one-time manual email confirmation click before it activates.
- **Verification**: After apply and confirmation, use `aws cloudwatch set-alarm-state --alarm-name flakey-production-unhealthy-hosts --state-value ALARM --state-reason test` and confirm an email is received within 60s.

---

## Priority: low

### L1. RDS security group has unnecessary `0.0.0.0/0` egress rule
- **File(s)**: `infra/modules/rds/main.tf:18-24`
- **Category**: misconfiguration
- **Problem**: The RDS security group has an egress rule allowing all outbound traffic. RDS PostgreSQL does not initiate outbound connections. The rule is never exercised and unnecessarily broadens the security group's surface area.
- **Evidence**:
  ```hcl
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ```
- **Proposed change**: Remove the egress block entirely. AWS security groups default to implicit deny-all-egress when no egress rules are defined.
- **Risk if applied**: None. RDS initiates no outbound connections.
- **Verification**: `terraform plan` must show the egress rule removed. ECS-to-RDS connectivity (controlled by the RDS ingress rule, not this egress) must still work.

---

### L2. Artifact S3 bucket has no versioning
- **File(s)**: `infra/modules/s3/main.tf:1-33`
- **Category**: misconfiguration
- **Problem**: The artifacts bucket has encryption and a lifecycle policy but no versioning. If a test run upload writes to the same S3 key (e.g. a re-run with the same CI run ID and the same screenshot filename), the previous file is silently overwritten and unrecoverable. Screenshots and videos linked in the database are lost.
- **Evidence**: No `aws_s3_bucket_versioning` resource references `aws_s3_bucket.artifacts`.
- **Proposed change**:
  ```diff
  + resource "aws_s3_bucket_versioning" "artifacts" {
  +   bucket = aws_s3_bucket.artifacts.id
  +   versioning_configuration { status = "Enabled" }
  + }
  ```
  Update the lifecycle rule to add `noncurrent_version_expiration { noncurrent_days = 30 }` to prevent unbounded storage growth from old versions.
- **Risk if applied**: Enabling versioning on an existing bucket is non-destructive. All current objects become version-aware with no content change.
- **Verification**: Upload the same key twice. `aws s3api list-object-versions --bucket <bucket> --prefix <key>` must show two versions.

---

### L3. `infra/.gitignore` excludes `.terraform.lock.hcl` — provider lock file should be committed
- **File(s)**: `infra/.gitignore:6`
- **Category**: bug
- **Problem**: `.terraform.lock.hcl` is gitignored. This file records exact provider versions and platform hashes. Excluding it means every `terraform init` on a new machine resolves providers fresh, which can silently pick up a new provider minor/patch version with breaking behavior changes. The Terraform documentation explicitly recommends committing this file.
- **Evidence**:
  ```
  .terraform.lock.hcl
  ```
- **Proposed change**:
  ```diff
  - .terraform.lock.hcl
  ```
  Remove from `.gitignore`, run `terraform init` to generate the file, and commit it.
- **Risk if applied**: None. Any CI pipeline that previously re-resolved providers on each run will now use locked versions.
- **Verification**: Delete `.terraform/` and re-run `terraform init` on two separate machines. Both must produce identical provider versions.

---

### L4. Helm chart `image.pullPolicy: IfNotPresent` with `tag: latest` — stale image on upgrade
- **File(s)**: `chart/values.yaml:4-5`
- **Category**: misconfiguration
- **Problem**: The default image tag is `latest` and the pull policy is `IfNotPresent`. Kubernetes will not re-pull `:latest` if a local copy already exists on the node. A `helm upgrade` that pushes a new `:latest` image will silently run the old code on nodes with a cached `:latest` layer.
- **Evidence**:
  ```yaml
  image:
    tag: latest
    pullPolicy: IfNotPresent
  ```
- **Proposed change**:
  ```diff
  - tag: latest
  + tag: ""  # Must be set at deploy time, e.g. --set image.tag=v1.2.3
  ```
  Add a validation in `_helpers.tpl` (can be combined with M8's guard):
  ```hcl
  {{- if eq .Values.image.tag "" -}}
  {{- fail "image.tag must be set to a specific version tag" -}}
  {{- end -}}
  ```
  If `:latest` is intentionally kept, change `pullPolicy: Always`.
- **Risk if applied**: Helm installs without `--set image.tag=<version>` fail with a clear message.
- **Verification**: `helm template . --set image.tag=""` must error. `helm template . --set image.tag=v1.0.0` must produce a Deployment with the correct tag.

---

### L5. Postman upload script uses old brand name "Flakey" in user-visible comment
- **File(s)**: `examples/postman/scripts/upload.js:4`
- **Category**: inconsistency
- **Problem**: The script comment says "Uploads Newman JUnit results to **Flakey** via the CLI." All other CI examples (GitHub Actions, GitLab, Bitbucket, jest/upload.js, selenium/upload.js) correctly use "Better Testing" or are neutral. This is the only outlier.
- **Evidence**:
  ```js
  /**
   * Uploads Newman JUnit results to Flakey via the CLI.
  ```
- **Proposed change**:
  ```diff
  - * Uploads Newman JUnit results to Flakey via the CLI.
  + * Uploads Newman JUnit results to Better Testing via the CLI.
  ```
- **Risk if applied**: None.
- **Verification**: `grep -r 'to Flakey\b' examples/` returns no results after the change.
