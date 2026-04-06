import pool from "./db.js";

export async function dispatchWebhooks(orgId: number, event: string, payload: object): Promise<void> {
  try {
    const result = await pool.query(
      "SELECT url FROM webhooks WHERE org_id = $1 AND active = true AND $2 = ANY(events)",
      [orgId, event]
    );

    for (const row of result.rows) {
      fetch(row.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch((err) => {
        console.error(`Webhook dispatch to ${row.url} failed:`, err.message);
      });
    }
  } catch (err) {
    console.error("Webhook dispatch error:", err);
  }
}
