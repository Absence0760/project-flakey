# Backup, restore & disaster recovery (self-hosted)

Operational runbook for a self-hosted Flakey deployment on the Terraform stack
in [`infra/`](../../infra/) (AWS ECS Fargate + RDS Postgres + S3 + CloudFront).
Covers what's backed up, how to restore it, the disaster-recovery playbook, and
the encryption-at-rest posture for a SOC 2 / GovRAMP context.

> Scope: the **managed AWS** deployment. A laptop/local-compose deployment
> (`pnpm dev`) keeps state in Docker volumes — back those up with your normal
> Docker/host backup; the AWS specifics below don't apply.

## What holds state

| Store | Contents | Backup mechanism |
|---|---|---|
| **RDS Postgres** | All application data — orgs, users, runs/specs/tests, audit log, integration config (secrets encrypted at the app layer) | Automated backups + PITR; final snapshot on destroy |
| **S3 `artifacts` bucket** | Screenshots, videos, DOM snapshots | Versioning + lifecycle; app-layer deletion on retention prune |
| **AWS Secrets Manager** | `JWT_SECRET`, `FLAKEY_ENCRYPTION_KEY`, DB passwords, bootstrap admin password | AWS-managed; recover via version stages |
| **S3 `frontend` bucket** | Built static SPA | Rebuildable from source (`pnpm build:frontend` + deploy) — not backed up |

Everything load-bearing is in RDS + the artifacts bucket + Secrets Manager. The
frontend bucket is disposable (redeploy from source).

## Recovery objectives (current posture)

| Objective | Value | Set by |
|---|---|---|
| **RPO** (max data loss) | ~5 min for RDS (PITR granularity); near-zero for S3 (versioned writes) | `backup_retention_period` |
| **RTO** (time to restore) | ~30–60 min (RDS restore is the long pole) | manual restore |
| **Backup retention** | 7 days (RDS automated); 365 days (S3 artifact lifecycle) | `infra/modules/rds/main.tf:47`, `infra/modules/s3/main.tf` |

These are the **defaults shipped in `infra/`**. Tune `backup_retention_period`
and add cross-region copy (see [Gaps](#gaps--hardening-backlog)) to meet a
stricter RPO/RTO if your compliance scope requires it.

## RDS Postgres

### What's configured (`infra/modules/rds/main.tf`)

- `backup_retention_period = 7` — 7 days of automated daily backups **+
  point-in-time recovery** (PITR) to any second within the window.
- `storage_encrypted = true` — encrypted at rest (see [Encryption](#encryption-at-rest)).
- `deletion_protection = true` — the instance cannot be deleted without first
  clearing the flag (guards against `terraform destroy` / console fat-fingers).
- `skip_final_snapshot = false` + `final_snapshot_identifier` — a final snapshot
  is taken automatically if the instance is ever destroyed.
- `multi_az = var.rds_multi_az` — set `rds_multi_az = true` in prod for automatic
  AZ failover (synchronous standby).

### Restore — point in time (the common case: bad migration, bad delete)

PITR creates a **new** instance; it never overwrites the running one.

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier <app>-<env> \
  --target-db-instance-identifier <app>-<env>-restore \
  --restore-time 2026-06-06T17:55:00Z \
  --no-multi-az
```

Then cut over by pointing the backend at the restored endpoint:
1. Update the RDS endpoint the ECS task reads (the `DB_HOST`-equivalent in
   `infra/`), or rename instances so the restored one takes the canonical name.
2. Force a new ECS deployment so tasks pick up the new endpoint:
   `aws ecs update-service --cluster <app>-<env> --service <app>-<env> --force-new-deployment`.
3. Verify `GET /health` and a sample tenant's data.

### Restore — from a snapshot (automated or the final snapshot)

```bash
aws rds describe-db-snapshots --db-instance-identifier <app>-<env>     # list
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier <app>-<env>-restore \
  --db-snapshot-identifier <snapshot-id>
```

Cut over as above.

> **Migrations after restore.** A restored DB is at whatever schema version the
> backup held. If you restored to recover from a *bad migration*, do **not**
> blindly re-run `./backend/migrate.sh` — confirm the target schema version
> first. Migrations are idempotent (`IF NOT EXISTS` etc.), but a half-applied
> bad migration needs the fix, not a re-run. See
> [backend/docs/migrations.md](../../backend/docs/migrations.md).

## S3 artifacts

### What's configured (`infra/modules/s3/main.tf`)

- **Versioning enabled** — overwrites and deletes are recoverable; a key
  collision (e.g. a re-run emitting the same screenshot path) doesn't silently
  destroy the prior object.
- **SSE-KMS** (`aws:kms`, `alias/aws/s3`) — encrypted at rest.
- **Public access fully blocked** — served only via the app/CloudFront.
- **Lifecycle:** transition to `STANDARD_IA` at 90 days, **expire at 365 days**,
  and expire noncurrent versions after 30 days (so versioning doesn't grow
  unbounded). This is the storage-cost backstop.

### TTL is aligned with per-org retention at the app layer

Per-org data retention (`organizations.retention_days`) prunes old runs nightly
(`backend/src/retention.ts`), and that path **also deletes the run's artifacts**
via `storage.deleteRun(runId)` — so artifacts don't outlive their DB rows. The
365-day S3 lifecycle is a safety net for anything the app-layer delete misses
(orphans from interrupted writes), not the primary cleanup.

### Restore an artifact (accidental delete / overwrite)

Versioning makes this recoverable:

```bash
aws s3api list-object-versions --bucket <artifacts-bucket> --prefix runs/<id>/
# restore a specific version by copying it back over the current key, or
# delete the delete-marker to undo a delete:
aws s3api delete-object --bucket <artifacts-bucket> --key <key> --version-id <delete-marker-version-id>
```

## Secrets (AWS Secrets Manager)

`JWT_SECRET`, `FLAKEY_ENCRYPTION_KEY`, the DB passwords, and the bootstrap admin
password are stored in Secrets Manager and injected into the ECS task as
`secrets` (`valueFrom` ARNs in `infra/modules/ecs/main.tf`) — never as plaintext
env. Secrets Manager keeps prior versions (`AWSCURRENT` / `AWSPREVIOUS` stages),
so a bad rotation is recoverable by promoting the previous version.

**`FLAKEY_ENCRYPTION_KEY` is the most consequential secret to back up.** It
encrypts every org's integration secrets (Jira tokens, PagerDuty keys) at the
app layer. **If it is lost, those secrets are unrecoverable** even with a full
RDS restore — the ciphertext in the DB can't be decrypted. Treat it like a root
key: ensure it's in Secrets Manager (it is, by default) and that your
Secrets-Manager backup/replication policy covers it.

## Encryption at rest

| Layer | Mechanism |
|---|---|
| RDS storage | `storage_encrypted = true` (KMS) — all DB data + automated backups + snapshots are encrypted |
| S3 artifacts / frontend / logs | SSE-KMS (`aws:kms`) on artifacts + frontend; SSE-S3 (AES256) on the access-log bucket (S3 logging can't target a CMK) |
| Integration secrets (app layer) | AES-256-GCM via `FLAKEY_ENCRYPTION_KEY` **before** they hit Postgres — defense in depth on top of RDS encryption. Key format validated at boot; the backend refuses to start in production without it |
| Secrets in transit to ECS | Secrets Manager `valueFrom`, decrypted into the task at launch |

In-transit encryption (TLS) is out of scope for this runbook — it's terminated
at CloudFront / the ALB.

## Secret & key rotation

- **`FLAKEY_ENCRYPTION_KEY`** rotates via the dual-key CLI: set the new key as
  primary and the old as secondary, run `npm run rotate-keys` in `backend/` to
  re-encrypt every org's secrets under the new key, then drop the old key. Full
  procedure: [backend/docs/integrations.md](../../backend/docs/integrations.md).
  Do this from a one-shot ECS task / maintenance container with both key
  versions available — never with only the new key (you'd lose the ability to
  decrypt existing ciphertext mid-rotation).
- **`JWT_SECRET`** rotation invalidates live sessions on cutover (all tokens
  signed with the old secret fail) — rotate during a maintenance window or
  accept that users re-authenticate. Update the Secrets Manager value, then
  `--force-new-deployment` the ECS service.
- **DB passwords** — rotate in Secrets Manager + RDS, then redeploy ECS.

> A **secret-rotation UI** on top of the `rotate-keys` CLI is proposed but
> deliberately deferred pending security review — see
> [docs/proposals/phase-14-sso.md](../proposals/phase-14-sso.md). Until then,
> rotation is the CLI procedure above.

## Disaster-recovery playbook

| Scenario | Response |
|---|---|
| **Single-AZ failure** | Automatic if `rds_multi_az = true` (RDS fails over to the standby; ECS reschedules tasks across AZs). No manual action. |
| **Accidental DB delete** | Blocked by `deletion_protection`. If the flag was cleared, restore from the final snapshot or an automated snapshot. |
| **Bad migration / bad bulk delete** | PITR to just before the event (see above). |
| **Artifact deleted/overwritten** | Recover the prior S3 version. |
| **Bad secret rotation** | Promote the `AWSPREVIOUS` version in Secrets Manager, redeploy ECS. |
| **Region failure** | **Manual rebuild** today (see gaps) — `terraform apply` in a new region, restore RDS from a copied snapshot, restore artifacts from a replicated bucket. Only possible if cross-region copy/replication is enabled. |

## Restore drills

Backups you haven't restored aren't backups. At least quarterly (and as a SOC 2
control):
1. Restore the latest automated snapshot into a throwaway instance.
2. Point a staging backend at it; confirm `GET /health` and tenant data integrity.
3. Tear it down. Record the RTO observed and any drift from this runbook.

## Gaps & hardening backlog

Honest list of what the shipped `infra/` does **not** yet do — decide per
compliance scope:

- **No cross-region DR.** RDS automated backups + the artifacts bucket are
  single-region. For region-failure survivability, enable RDS automated-backup
  cross-region replication (or scheduled snapshot copy) and S3 Cross-Region
  Replication on the artifacts bucket. Not on by default (cost).
- **7-day PITR window.** Fine for operational recovery; lengthen
  `backup_retention_period` if your retention policy needs longer.
- **No automated restore-drill.** The drill above is manual; consider scripting
  it.
- **`multi_az` is opt-in.** Confirm `rds_multi_az = true` for any production /
  GovRAMP deployment.
