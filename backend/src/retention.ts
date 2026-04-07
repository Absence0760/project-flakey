import pool from "./db.js";
import { rmSync, existsSync } from "fs";
import { join } from "path";

export async function runRetentionCleanup(): Promise<void> {
  try {
    const orgs = await pool.query(
      "SELECT id, retention_days FROM organizations WHERE retention_days IS NOT NULL"
    );

    for (const org of orgs.rows) {
      const runs = await pool.query(
        "DELETE FROM runs WHERE org_id = $1 AND created_at < NOW() - ($2 || ' days')::INTERVAL RETURNING id",
        [org.id, String(org.retention_days)]
      );

      for (const run of runs.rows) {
        const dir = join("uploads", "runs", String(run.id));
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
        }
      }

      if (runs.rows.length > 0) {
        console.log(`Retention: deleted ${runs.rows.length} run(s) older than ${org.retention_days}d for org ${org.id}`);
      }
    }
  } catch (err) {
    console.error("Retention cleanup error:", err);
  }
}
