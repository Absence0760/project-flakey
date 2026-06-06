# Flakey Helm chart

Deploys the Flakey backend (Express/Node) to Kubernetes, optionally with a
bundled PostgreSQL (Bitnami subchart) and a PVC for local artifact storage.

```bash
helm install flakey ./chart \
  --set auth.jwtSecret="$(openssl rand -hex 32)" \
  --set app.encryptionKey="$(openssl rand -hex 32)"
```

`auth.jwtSecret` and `app.encryptionKey` are both **required** — the chart's
`validateValues` guard fails the render if either is left at its default/empty.
The backend likewise refuses to boot in production without them.

## Secrets

Every sensitive value can be supplied inline (rendered into a chart-managed
`Secret`) or pulled from an `existingSecret` you manage out of band:

| Value | Inline | Existing secret (`existing*`) | Secret key |
|---|---|---|---|
| JWT signing secret | `auth.jwtSecret` | `auth.existingSecret` | `jwt-secret` |
| DB passwords | `database.password` / `database.migrationPassword` | `database.existingSecret` | `password`, `migration-password` |
| Encryption key | `app.encryptionKey` | `app.existingEncryptionSecret` | `encryption-key` |
| Old encryption key (rotation) | `app.encryptionKeyOld` | `app.existingEncryptionSecret` | `encryption-key-old` |
| SMTP password | `smtp.password` | `smtp.existingSecret` | `smtp-password` |
| Bootstrap admin password | `app.bootstrapAdminPassword` | `app.existingBootstrapSecret` | `bootstrap-admin-password` |

## Encryption key rotation

`app.encryptionKey` (→ `FLAKEY_ENCRYPTION_KEY`) encrypts integration secrets
(Jira tokens, PagerDuty keys) at rest with AES-256-GCM. Keep it **stable**
across upgrades — losing it makes previously stored secrets undecryptable.

To rotate without downtime, the backend supports a dual-key window via
`app.encryptionKeyOld` (→ `FLAKEY_ENCRYPTION_KEY_OLD`), a read-only fallback.
The full procedure is documented in
[backend/docs/integrations.md](../backend/docs/integrations.md)
(§ Secrets encryption → Rotation). In chart terms:

1. **Deploy with both keys.** Set the new primary as `app.encryptionKey` and
   the current key as `app.encryptionKeyOld`, then `helm upgrade`. New writes
   use the primary; old ciphertexts stay readable via the fallback.

   ```bash
   helm upgrade flakey ./chart \
     --set app.encryptionKey="$NEW_KEY" \
     --set app.encryptionKeyOld="$OLD_KEY" \
     --reuse-values
   ```

   With an `existingEncryptionSecret`, add the old key under the
   `encryption-key-old` key of that secret and still set `app.encryptionKeyOld`
   (any non-empty value) so the chart injects `FLAKEY_ENCRYPTION_KEY_OLD`.

2. **Re-encrypt** existing rows under the new primary by running the backend's
   `npm run rotate-keys` (see the doc above for the exact invocation — preview
   with `-- --dry-run` first). It is idempotent.

3. **Drop the old key.** Clear `app.encryptionKeyOld` (or remove
   `encryption-key-old` from your existing secret) and `helm upgrade` again so
   `FLAKEY_ENCRYPTION_KEY_OLD` is no longer injected.

## First-admin bootstrap

The chart ships **no default credentials**. To seed a single admin account on
first boot, set both bootstrap values — the password is sourced from a Secret,
never a ConfigMap:

```bash
helm install flakey ./chart \
  --set auth.jwtSecret="$(openssl rand -hex 32)" \
  --set app.encryptionKey="$(openssl rand -hex 32)" \
  --set app.bootstrapAdminEmail="admin@example.com" \
  --set app.bootstrapAdminPassword="$(openssl rand -base64 24)"
```

These render `FLAKEY_BOOTSTRAP_ADMIN_EMAIL` and
`FLAKEY_BOOTSTRAP_ADMIN_PASSWORD` only when set. Leave them empty to disable
bootstrap entirely (e.g. when registration is open or the admin already
exists). For production, prefer `app.existingBootstrapSecret` (key:
`bootstrap-admin-password`) over an inline plaintext password.
