import pool from "./db.js";
import { getStorage } from "./storage.js";

export async function runRetentionCleanup(): Promise<void> {
  try {
    const storage = getStorage();
    const orgs = await pool.query(
      "SELECT id, retention_days FROM organizations WHERE retention_days IS NOT NULL"
    );

    for (const org of orgs.rows) {
      const days = Number(org.retention_days);
      if (!days || days <= 0) continue;

      const runs = await pool.query(
        "DELETE FROM runs WHERE org_id = $1 AND created_at < NOW() - ($2 || ' days')::INTERVAL RETURNING id",
        [org.id, String(days)]
      );

      for (const run of runs.rows) {
        await storage.deleteRun(run.id);
      }

      if (runs.rows.length > 0) {
        console.log(`Retention: deleted ${runs.rows.length} run(s) older than ${org.retention_days}d for org ${org.id}`);
      }
    }
    // Clean up expired org invites
    const invites = await pool.query(
      "DELETE FROM org_invites WHERE expires_at < NOW()"
    );
    if (invites.rowCount && invites.rowCount > 0) {
      console.log(`Retention: deleted ${invites.rowCount} expired invite(s)`);
    }
  } catch (err) {
    console.error("Retention cleanup error:", err);
  }
}
