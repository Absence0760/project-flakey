import pool, { tenantQuery } from "./db.js";
import { sendEmail } from "./email.js";

/**
 * Scheduled report dispatch. Runs periodically and delivers any reports whose
 * schedule window has elapsed since their last_sent_at (or since creation).
 *
 * A report matches if:
 *   - active = true
 *   - the current UTC hour >= hour_utc
 *   - it hasn't been sent today (daily) or this week on the correct day (weekly)
 */
// Arbitrary stable int used as the advisory-lock key. Any 64-bit int works
// as long as it doesn't collide with other advisory locks in the app.
const SCHEDULED_REPORTS_LOCK_KEY = 0x666c616b79; // "flaky" (441_119_769_721, fits in JS Number safely)

export async function runScheduledReports(): Promise<void> {
  // Try to take a session-scoped advisory lock so only one backend replica at
  // a time dispatches reports. If another replica is already running, exit
  // quietly — it'll run again on the next tick.
  const lockClient = await pool.connect();
  try {
    const got = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SCHEDULED_REPORTS_LOCK_KEY]
    );
    if (!got.rows[0]?.locked) {
      return;
    }

    const now = new Date();
    const currentHourUtc = now.getUTCHours();
    const currentDayOfWeek = now.getUTCDay();

    // Find all due reports across all orgs (no RLS — system task).
    const due = await pool.query(
      `SELECT id, org_id, name, cadence, day_of_week, hour_utc, channel, destination,
              suite_filter, last_sent_at
       FROM scheduled_reports
       WHERE active = true
         AND hour_utc <= $1
         AND (
           (cadence = 'daily'  AND (last_sent_at IS NULL OR last_sent_at::date < CURRENT_DATE))
           OR
           (cadence = 'weekly' AND day_of_week = $2
             AND (last_sent_at IS NULL OR last_sent_at < NOW() - INTERVAL '6 days'))
         )`,
      [currentHourUtc, currentDayOfWeek]
    );

    for (const r of due.rows) {
      try {
        await deliverReport(r);
        await pool.query("UPDATE scheduled_reports SET last_sent_at = NOW() WHERE id = $1", [r.id]);
      } catch (err) {
        console.error(`Scheduled report ${r.id} failed:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error("runScheduledReports error:", err);
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [SCHEDULED_REPORTS_LOCK_KEY]);
    } catch {
      /* best effort */
    }
    lockClient.release();
  }
}

async function deliverReport(report: any): Promise<void> {
  const since = report.cadence === "daily" ? "1 day" : "7 days";
  const suiteFilter = report.suite_filter ? " AND suite_name = $2" : "";
  const params: unknown[] = [`${since}`];
  if (report.suite_filter) params.push(report.suite_filter);

  const result = await tenantQuery(
    report.org_id,
    `SELECT
        COUNT(*)::int                                                        AS run_count,
        COALESCE(SUM(total), 0)::int                                         AS total,
        COALESCE(SUM(passed), 0)::int                                        AS passed,
        COALESCE(SUM(failed), 0)::int                                        AS failed,
        COALESCE(SUM(skipped), 0)::int                                       AS skipped,
        COALESCE(AVG(duration_ms), 0)::int                                   AS avg_duration_ms,
        COUNT(*) FILTER (WHERE failed > 0)::int                              AS runs_with_failures
     FROM runs
     WHERE created_at > NOW() - $1::interval${suiteFilter}`,
    params
  );

  const summary = result.rows[0];
  const passRate =
    summary.total > 0 ? Math.round((summary.passed / summary.total) * 1000) / 10 : 0;

  const title =
    report.cadence === "daily"
      ? `Daily test report — ${new Date().toISOString().slice(0, 10)}`
      : `Weekly test report — ${new Date().toISOString().slice(0, 10)}`;

  const body =
    `${title}\n\n` +
    `${summary.run_count} runs, ${summary.total} tests\n` +
    `Passed: ${summary.passed}  Failed: ${summary.failed}  Skipped: ${summary.skipped}\n` +
    `Pass rate: ${passRate}%\n` +
    `Runs with failures: ${summary.runs_with_failures}\n` +
    `Avg duration: ${Math.round(summary.avg_duration_ms / 100) / 10}s`;

  if (report.channel === "email") {
    await deliverEmailReport(report.destination, title, body);
    return;
  }

  // webhook / slack — POST to destination URL
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";
  const dashboardUrl = `${frontendUrl}/dashboard`;

  let formatted: object;
  if (report.channel === "slack") {
    formatted = {
      text: `${title}\n${body}\n${dashboardUrl}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: title } },
        { type: "section", text: { type: "mrkdwn", text: "```" + body + "```" } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Open dashboard" }, url: dashboardUrl },
          ],
        },
      ],
    };
  } else {
    formatted = {
      event: "report.summary",
      title,
      body,
      cadence: report.cadence,
      dashboard_url: dashboardUrl,
      summary,
    };
  }
  await fetch(report.destination, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formatted),
  });
}

async function deliverEmailReport(to: string, subject: string, body: string): Promise<void> {
  try {
    await sendEmail({ to, subject, text: body });
  } catch (err) {
    console.log(`[scheduled-report] email delivery failed to=${to} subject="${subject}": ${(err as Error).message}`);
  }
}
