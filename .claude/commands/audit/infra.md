---
description: Audit the AWS Terraform stacks under infra/ — IAM least-privilege, RDS / S3 encryption, secrets handling, per-env naming
---

Audit the Terraform stacks at `infra/` against the AWS deploy plan documented in `infra/README.md`.

## Goal

The deploy stack runs the backend on ECS Fargate behind an ALB, with RDS Postgres, S3 buckets for the SvelteKit static site + run artifacts, CloudFront in front of S3, ECR for backend images, and Secrets Manager for runtime secrets. A permissive OIDC trust on the deploy role lets a fork's PR write to your account; a public RDS endpoint is a brute-force surface; a missing `lifecycle.ignore_changes` on the ECS service makes Terraform fight the GitHub Actions deploy on every push. Catch the high-cost mistakes before `terraform apply` reaches a real account.

## What to check

1. **State backend + locking.** `infra/bootstrap/main.tf` — bucket has Public Access Block (all four flags), versioning enabled, server-side encryption (`AES256` at minimum, `aws:kms` better), and is not `force_destroy = true`. Every non-bootstrap stack has a `backend "s3"` block pointing at this bucket with `encrypt = true` and either S3-native locking (`use_lockfile = true`, Terraform ≥ 1.10) or a DynamoDB lock table — pick one and verify consistency. Flag any stack that initialises against a local backend (`backend "local"`) — that's a per-developer state file that races with CI.

2. **OIDC trust policy.** Wherever the deploy IAM role is defined (likely `infra/modules/secrets` or a dedicated `infra/oidc/` if it exists; otherwise document its absence as a Critical finding) — the role's trust policy must:
   - Pin `:aud = "sts.amazonaws.com"` (or `token.actions.githubusercontent.com:aud`)
   - Pin `:sub` `StringLike` matching exactly the intended ref (`refs/heads/main`, `refs/tags/v*`, or the org/repo form `repo:Absence0760/project-flakey:ref:...`)
   - Wildcards on `:sub` or missing `:sub` is the canonical "fork PR can assume your role" footgun

   If the deploy uses long-lived AWS access keys instead of OIDC, flag it Critical — keys can be exfiltrated; OIDC tokens can't.

3. **OIDC role permissions.** The deploy role's policy should be scoped per-resource:
   - ECR: `BatchCheckLayerAvailability`, `CompleteLayerUpload`, `InitiateLayerUpload`, `PutImage`, `UploadLayerPart`, `BatchGetImage`, `GetDownloadUrlForLayer` — limited to the specific repository ARN (no `arn:aws:ecr:*:*:repository/*`)
   - ECS: `UpdateService`, `RegisterTaskDefinition`, `DescribeServices`, `DescribeTaskDefinition` — limited to the specific cluster + service ARNs
   - S3: action limited to the env's bucket ARN (no `*` for the whole account)
   - CloudFront: `CreateInvalidation` only, on the specific distribution ARN
   - No `iam:*`, `sts:AssumeRole` (other than the role's own `AssumeRoleWithWebIdentity`), `secretsmanager:*`, `kms:*` actions on the deploy role

4. **RDS.** `infra/modules/rds/main.tf` —
   - `publicly_accessible = false` (or a strong reason if `true`)
   - `storage_encrypted = true`
   - `backup_retention_period >= 7` for prod
   - `deletion_protection = true` for prod
   - Master password from Secrets Manager (not a `var.password` Terraform variable that lives in tfvars)
   - `apply_immediately = false` for production (rolling password rotates / parameter changes shouldn't surprise users)
   - VPC security group allows only the ECS task SG inbound, not `0.0.0.0/0`
   - `multi_az` is a variable with a sensible default for prod and `false` for preview (cost guardrail)

5. **ECS.** `infra/modules/ecs/main.tf` —
   - Task definition has `runtime_platform.cpu_architecture = "ARM64"` if the build is multi-arch (Graviton is cheaper for the same code)
   - `execution_role_arn` minimal: `AmazonECSTaskExecutionRolePolicy` only, plus per-secret read scoped to the secret ARN — no `secretsmanager:GetSecretValue` on `*`
   - `task_role_arn` is separate from execution role and only has the perms the running task needs (e.g. S3 read/write to the artifacts bucket)
   - `awslogs` driver with `retention_in_days` set on the log group (default infinite is a cost trap)
   - `aws_ecs_service` has `lifecycle.ignore_changes = [task_definition, desired_count]` so CI's `update-service` doesn't fight Terraform; verify the list is **minimal** (anything else in `ignore_changes` is suspicious)
   - Health check path / grace period is set
   - Fargate task SG is restrictive (egress allowed; ingress only from ALB SG)

6. **ECR.** `infra/modules/ecr/main.tf` —
   - `image_scanning_configuration.scan_on_push = true`
   - `image_tag_mutability = "IMMUTABLE"` (or a strong reason if `MUTABLE`)
   - Lifecycle policy that retains tagged `v*` images and expires only untagged (audit fix `deba498` flagged this — confirm it's still right)
   - `encryption_configuration` set (KMS or AES256)

7. **S3 buckets.** Every bucket (state, artifacts, frontend static) —
   - `aws_s3_bucket_public_access_block` with all four flags `true`
   - `aws_s3_bucket_versioning` enabled
   - `aws_s3_bucket_server_side_encryption_configuration` set
   - For the static-site bucket: `aws_s3_bucket_policy` grants `Principal: { Service = "cloudfront.amazonaws.com" }` ONLY (not `Principal: "*"`) and conditions on `AWS:SourceArn`
   - No legacy `aws_s3_bucket_acl` (the modern API forbids ACLs)
   - Lifecycle rules expiring non-current versions on the artifacts bucket (cost guardrail; runs accumulate fast)

8. **CloudFront.** `infra/modules/s3/main.tf` (or wherever it lives) —
   - `viewer_protocol_policy = "redirect-to-https"` (default behavior) or `"https-only"`
   - `minimum_protocol_version = "TLSv1.2_2021"` or stricter
   - `origin_access_control_id` set on every S3 origin (not the legacy `origin_access_identity`)
   - `response_headers_policy_id` attached, with HSTS / `content_type_options` / `referrer_policy` / `frame_options = "DENY"` / a CSP
   - `price_class` set to `PriceClass_100` or `PriceClass_200` (not `PriceClass_All` unless explicitly justified)
   - SPA fallback `custom_error_response` rewrites 404 → 200 + `/index.html`

9. **Secrets Manager.** `infra/modules/secrets/main.tf` —
   - One secret per real secret (don't bundle JWT_SECRET + DB_PASSWORD + FLAKEY_ENCRYPTION_KEY into a single JSON blob if rotation will only touch one)
   - `recovery_window_in_days >= 7` so a misclick can be reversed
   - KMS-encrypted (default AWS-managed key is fine; CMK is better for prod)
   - ECS task definition reads via `secrets[].valueFrom = aws_secretsmanager_secret.x.arn` so the secret never appears in env-as-tfvar

10. **Per-env naming.** Per-env stacks must not name resources without an env suffix — e.g. an ECS service named `flakey-backend` (no env) would conflict between prod and preview. Confirm a `local.resource_prefix = "flakey-${var.env}"` (or equivalent) is used for every named resource that has cluster-wide uniqueness (CloudFront response-headers policies, IAM roles, security groups inside a shared VPC).

11. **Tagging.** Every resource that supports `tags` has them, and the tag set includes at minimum `project`, `env`, `managed = "terraform"`. The module passes `var.tags` through to every taggable resource. Cost attribution + ownership both depend on this.

12. **Drift hygiene.** Read every `lifecycle { ignore_changes = [...] }` block and confirm:
    - It's there because CI legitimately mutates the field
    - The list is minimal — adding `[tags]` for example would silently let manual console changes accumulate

13. **Cost guardrails.**
    - CloudWatch log retention set on every log group (default = forever)
    - ECS `min_capacity` reasonable; auto-scaling capped at a sane `max_capacity`
    - RDS `instance_class` documented per env (preview should not run a db.r6.4xlarge by default)
    - `infra/modules/budget/` exists and emits a billing alarm — confirm it's wired into prod

14. **Provider + Terraform pinning.** Every stack has a `versions.tf` with `required_version` and pinned `required_providers`. `.terraform.lock.hcl` should be committed once `terraform init` has been run.

## Report

- **Critical** — OIDC trust policy too broad (fork PR can assume role); long-lived AWS keys for deploy; public RDS endpoint; secrets file committed in plaintext; KMS rotation disabled with long-lived keys; public S3 bucket without OAC.
- **High** — bucket versioning off; missing PAB on a bucket; ECR `MUTABLE` tags; ECS task role over-scoped (`*` instead of specific ARNs); deletion protection off on prod RDS.
- **Medium** — log retention infinite; missing security headers; weak CSP; missing tags; drift-prone resource (no `ignore_changes` on a CI-mutated field).
- **Low** — version pin loose; undocumented `lifecycle` choice; missing `sensitive = true` on a borderline value.

For each finding: file:line + the concrete change to make. Don't apply fixes without explicit confirmation.

## Useful starting points

- `infra/README.md` — the apply-order walkthrough
- `infra/main.tf` — root-module wiring
- `infra/variables.tf`, `infra/versions.tf`
- `infra/bootstrap/` — state bucket
- `infra/modules/{ecr,ecs,rds,s3,networking,secrets,budget}/` — per-resource modules

## Delegate to

`general-purpose` agent with this file as the prompt body. Reads ~30 small `.tf` files plus checks 2–3 conditions per file, well within one agent's reading window.

Read-only. Findings only. Don't run `terraform plan` or `terraform apply` — those reach AWS.
