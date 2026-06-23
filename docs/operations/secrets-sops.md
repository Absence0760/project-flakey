# Managing production secrets with sops (optional)

flakey's three app secrets — `JWT_SECRET`, `FLAKEY_ENCRYPTION_KEY`, and the
`flakey_app` DB-role password — are **auto-generated** by Terraform
(`random_*` → AWS Secrets Manager) by default. That's the zero-config path: a
fresh `terraform apply` just works, no secret material in git.

This page documents the **opt-in** alternative: sourcing those three secrets
from a [sops](https://github.com/getsops/sops)-encrypted file backed by AWS KMS,
so the values are **durable** (survive tfstate loss), **version-controlled**, and
**recoverable**. It mirrors the pattern used in `meryl-green-designs`, with one
deliberate difference: the encrypted material lives in a **private** repo, never
in this public one.

> **Why durability matters here.** With the default `random_*` path, losing or
> rebuilding tfstate makes the next apply generate a **new** `encryption_key` —
> which makes every AES-GCM-encrypted integration secret (Jira tokens, PagerDuty
> keys, SSO client secrets, …) undecryptable. Pinning the value in sops removes
> that footgun.

## How it's wired

- **Public repo (this one)** holds only the *mechanism*, which is secret-free:
  the `carlpett/sops` provider (`infra/versions.tf`), a count-gated
  `data "sops_file"` keyed off the `sops_secrets_file` variable
  (`infra/main.tf`), and three optional `*_override` inputs on the secrets
  module. With `sops_secrets_file` empty, none of it is exercised — the provider
  plugin is downloaded by `terraform init` but the data source is `count = 0`.
- **Private repo (`infra-secrets`)** holds the encrypted values, the
  `.sops.yaml` creation rules, and the KMS-init script. See its own `README.md`.

Decryption happens **in-memory at plan/apply** via your AWS credential chain —
no decrypted file is ever written to disk.

> **Honest scope:** sops encrypts the secrets **in git**, not **in tfstate**.
> The decrypted values still land in `aws_secretsmanager_secret_version`'s
> `secret_string`, which is stored in the S3 state backend (protected by that
> bucket's SSE, exactly as the `random_*` values already are). sops is about a
> durable, encrypted-at-rest source of truth — not about removing secrets from
> state.

## One-time setup

1. **Create the private secrets repo.** Create `Absence0760/infra-secrets`
   (private) on GitHub. Push the scaffold from `~/github/infra-secrets/`.
2. **Create the KMS key.** From a checkout of that repo, authenticated to the
   **flakey** AWS account:
   ```
   ./bin/sops-init.sh --project flakey --region ap-southeast-2
   ```
   This creates `alias/flakey-sops` (idempotent), writes its ARN into
   `.sops.yaml`, and seeds `flakey/production.sops.yaml` from the example.
3. **Fill in the secret values** (see the two cases below), then:
   ```
   sops flakey/production.sops.yaml      # opens the decrypted file in $EDITOR
   ```
4. **Point Terraform at it.** In `infra/terraform.tfvars` (gitignored) or via
   `TF_VAR_sops_secrets_file`, set the path relative to the `infra/` dir, e.g.:
   ```hcl
   sops_secrets_file = "../../infra-secrets/flakey/production.sops.yaml"
   ```
5. `cd infra && terraform plan` — confirm the three secret versions now source
   the sops values and the `random_*` resources drop to `count = 0`.

### Secret format

Keep the file **flat** (nested keys become dotted keys in `.data`):

```yaml
jwt_secret: "<any long opaque string>"          # openssl rand -hex 32
encryption_key: "<64 lowercase hex chars>"      # openssl rand -hex 32  (MUST be 64 hex)
db_app_password: "<alphanumeric>"               # openssl rand -hex 24  (no special chars)
```

- `encryption_key` **must** be 64 lowercase hex chars (32 bytes) — `crypto.ts`'s
  `parseKey` requires `^[0-9a-f]{64}$`.
- `db_app_password` must stay alphanumeric: `entrypoint.sh` runs
  `ALTER ROLE flakey_app PASSWORD …` with it, and special characters can break
  that. (The default `random_password.db_app` uses `special = false` for the
  same reason.)

## Case A — adopting sops on an ALREADY-DEPLOYED flakey (zero-downtime)

**Use the CURRENT values, not fresh ones.** A changed `jwt_secret` logs everyone
out; a changed `encryption_key` orphans all encrypted integration data. Read the
live values out of Secrets Manager and put those exact strings into the sops
file:

```
aws secretsmanager get-secret-value --secret-id flakey-production/jwt-secret      --query SecretString --output text
aws secretsmanager get-secret-value --secret-id flakey-production/encryption-key  --query SecretString --output text
aws secretsmanager get-secret-value --secret-id flakey-production/db-app-password --query SecretString --output text
```

Then `terraform plan` is a **no-op on values**, and the module's `moved {}`
blocks make the `count` migration a no-op on the underlying `random_*` resources
(no destroy/recreate). Apply, done.

## Case B — greenfield (not yet deployed)

Generate fresh values with the commands above and encrypt them. Nothing to
migrate.

## Rotation (and its current limitation)

Rotating `jwt_secret` or `db_app_password` is safe: change the value, apply, ECS
rolls a new task. (`jwt` rotation logs users out; the app-password rotation is
re-applied to the role by `entrypoint.sh` on boot.)

**Rotating `encryption_key` is NOT yet wired end-to-end — do not just change it.**
The backend supports a two-key migration (`FLAKEY_ENCRYPTION_KEY_OLD` +
`npm run rotate-keys`, see `backend/src/crypto.ts`), but two gaps make a hard key
change unsafe today:

1. The ECS task definition (`infra/modules/ecs/main.tf`) does **not** plumb
   `FLAKEY_ENCRYPTION_KEY_OLD`, so the backend can't fall back to the old key in
   production.
2. `rotate-keys` only re-encrypts the Jira + PagerDuty columns — not SSO client
   secrets, SCIM tokens, the Jira-webhook secret, or audit-export tokens.

Until both are addressed, treat `encryption_key` as **fixed for the life of the
deployment** and always reuse the current value (Case A). Wiring real rotation
(an optional `encryption_key_old` → its own Secrets Manager secret + a
conditional ECS `secrets` entry + the matching IAM `GetSecretValue` ARN, plus
broadening `rotate-keys`) is a tracked follow-up — not part of the sops adoption.

## Disaster recovery

Access is governed by the KMS key policy (IAM), not by who can read the repo.
Lose your laptop → log in on a new machine, `aws configure`/SSO, `sops -d` works
again. **Lose the KMS key → the encrypted values are unrecoverable**, so rely on
AWS's annual key-material rotation (enabled by `sops-init`) and treat the
encrypted blobs in git as the backup of record. To add a second operator, grant
them `kms:Decrypt`/`kms:Encrypt` on the key in IAM — no re-encryption needed.
