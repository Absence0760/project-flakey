/**
 * Re-encrypt at-rest secrets under the primary encryption key.
 *
 * Usage:
 *   FLAKEY_ENCRYPTION_KEY=<new> FLAKEY_ENCRYPTION_KEY_OLD=<old> \
 *     npm run rotate-keys
 *
 * Flags:
 *   --dry-run   Report what would change without writing.
 *
 * Walks every org's integration secret columns. For each encrypted value,
 * attempts decryption under the primary key first; if that fails, falls
 * back to the old key and re-encrypts under the primary. Values already
 * current (or plaintext / null) are left alone.
 *
 * Safe to re-run. Runs in a single transaction per org so a partial
 * failure does not leave an org with mixed-key secrets.
 */
import pool from "../db.js";
import { rotateSecret } from "../crypto.js";

type SecretCol = "jira_api_token" | "pagerduty_integration_key";
const SECRET_COLUMNS: SecretCol[] = ["jira_api_token", "pagerduty_integration_key"];

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.FLAKEY_ENCRYPTION_KEY) {
    console.error("FLAKEY_ENCRYPTION_KEY must be set to the new primary key.");
    process.exit(1);
  }

  const rows = (
    await pool.query(
      `SELECT id, name, ${SECRET_COLUMNS.join(", ")} FROM organizations ORDER BY id`
    )
  ).rows as Array<{ id: number; name: string } & Record<SecretCol, string | null>>;

  let orgsWithChanges = 0;
  let fieldsRotated = 0;
  let orgsWithErrors = 0;

  for (const row of rows) {
    const updates: Partial<Record<SecretCol, string | null>> = {};
    const failures: string[] = [];

    for (const col of SECRET_COLUMNS) {
      try {
        const result = rotateSecret(row[col]);
        if (result.rotated) updates[col] = result.value;
      } catch (err) {
        failures.push(`${col}: ${(err as Error).message}`);
      }
    }

    if (failures.length > 0) {
      orgsWithErrors++;
      console.error(`  org ${row.id} (${row.name}): ROTATION FAILED`);
      for (const f of failures) console.error(`    - ${f}`);
      continue;
    }

    const keys = Object.keys(updates) as SecretCol[];
    if (keys.length === 0) continue;

    orgsWithChanges++;
    fieldsRotated += keys.length;
    console.log(`  org ${row.id} (${row.name}): rotating ${keys.join(", ")}`);

    if (!dryRun) {
      const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
      const params = keys.map((k) => updates[k]!);
      params.push(row.id as never);
      await pool.query(
        `UPDATE organizations SET ${sets} WHERE id = $${params.length}`,
        params
      );
    }
  }

  console.log("");
  console.log(`Scanned ${rows.length} org(s).`);
  console.log(`Rotated ${fieldsRotated} field(s) across ${orgsWithChanges} org(s).`);
  if (orgsWithErrors > 0) {
    console.log(`Errors in ${orgsWithErrors} org(s) — see above.`);
  }
  if (dryRun) console.log("(dry run — no writes performed)");
  if (orgsWithErrors > 0) process.exit(2);
}

main()
  .catch((err) => {
    console.error("Rotation failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
