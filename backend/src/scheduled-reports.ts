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

/**
 * Daily dedup predicate: true when a report has NOT already been sent on the
 * current calendar day.
 *
 * Anchored to UTC (not the DB session timezone) on purpose. The scheduling
 * decision below keys off `hour_utc` / `day_of_week`, both compared against
 * JS `getUTCHours()` / `getUTCDay()` — so "today" must mean the UTC calendar
 * day too. A bare `last_sent_at::date < CURRENT_DATE` resolves the day
 * boundary in the session's timezone (`SET TimeZone`, which defaults to the
 * server's setting). On a non-UTC session that boundary falls in the middle
 * of a UTC day, so a daily report can re-send within the same UTC day once the
 * local date rolls over while the UTC date hasn't. Forcing UTC keeps the dedup
 * consistent with the schedule regardless of how the DB session is configured.
 */
export const DAILY_NOT_SENT_TODAY_SQL =
  "(last_sent_at IS NULL OR (last_sent_at AT TIME ZONE 'UTC')::date < (NOW() AT TIME ZONE 'UTC')::date)";

/**
 * Weekly dedup predicate: true when a weekly report's send window is open —
 * either it has never been sent, or its last send was more than 6 days ago.
 *
 * Unlike the daily predicate this needs NO timezone anchoring: both sides are
 * `timestamptz`, so `last_sent_at < NOW() - INTERVAL '6 days'` is an
 * absolute-instant comparison that yields the same answer regardless of the DB
 * session timezone (no `::date` cast to resolve a calendar boundary). The
 * 6-day (not 7-day) window is deliberate slack: paired with the caller's
 * `day_of_week = <current UTC day>` gate, it lets a weekly report fire on its
 * scheduled weekday even when the prior week's send drifted later in the day,
 * while still blocking a second send within the same week. Exported so the
 * window can be unit-tested in isolation, mirroring DAILY_NOT_SENT_TODAY_SQL.
 */
export const WEEKLY_NOT_SENT_THIS_WEEK_SQL =
  "(last_sent_at IS NULL OR last_sent_at < NOW() - INTERVAL '6 days')";

export async function runScheduledReports(): Promise<void> {
  // Use a transaction-scoped advisory lock so the lock is automatically released
  // when the transaction ends — no explicit pg_advisory_unlock needed, eliminating
  // the risk of a leaked lock if the unlock call itself fails.
  const lockClient = await pool.connect();
  try {
    await lockClient.query("BEGIN");
    const got = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      [SCHEDULED_REPORTS_LOCK_KEY]
    );
    if (!got.rows[0]?.locked) {
      await lockClient.query("ROLLBACK");
      lockClient.release();
      return;
    }

    const now = new Date();
    const currentHourUtc = now.getUTCHours();
    const currentDayOfWeek = now.getUTCDay();

    // `scheduled_reports` is RLS-scoped, so we can't just SELECT across all
    // orgs in one shot — the policy's current_setting('app.current_org_id')::int
    // cast would fail on an empty string. Iterate orgs and run each query
    // inside a tenant context instead.
    const orgs = await pool.query("SELECT id FROM organizations");
    for (const { id: orgId } of orgs.rows) {
      const due = await tenantQuery(
        orgId,
        `SELECT id, org_id, name, cadence, day_of_week, hour_utc, channel, destination,
                suite_filter, last_sent_at
         FROM scheduled_reports
         WHERE active = true
           AND hour_utc <= $1
           AND (
             (cadence = 'daily'  AND ${DAILY_NOT_SENT_TODAY_SQL})
             OR
             -- Weekly window is an absolute-instant comparison (both sides
             -- timestamptz), so it's already timezone-independent.
             (cadence = 'weekly' AND day_of_week = $2
               AND ${WEEKLY_NOT_SENT_THIS_WEEK_SQL})
           )`,
        [currentHourUtc, currentDayOfWeek]
      );

      for (const r of due.rows) {
        try {
          await deliverReport(r);
          await tenantQuery(
            orgId,
            "UPDATE scheduled_reports SET last_sent_at = NOW() WHERE id = $1",
            [r.id]
          );
        } catch (err) {
          console.error(`Scheduled report ${r.id} failed:`, (err as Error).message);
        }
      }
    }

    await lockClient.query("COMMIT");
    lockClient.release();
  } catch (err) {
    console.error("runScheduledReports error:", err);
    try { await lockClient.query("ROLLBACK"); } catch { /* ignore */ }
    lockClient.release();
  }
}

/**
 * Deliver a single report immediately, bypassing the schedule window.
 *
 * Backs `POST /reports/:id/run` — an explicit admin "send a test now" action.
 * It must NOT be gated by hour_utc / day_of_week / active the way the
 * background sweep (runScheduledReports) is: the whole point of the button is
 * to verify a destination right now, whatever the wall-clock hour or weekday,
 * and whether or not the report is currently active.
 *
 * Stamps last_sent_at on success so the scheduled tick won't re-send the same
 * window. Returns false when no report with that id exists in the org (RLS
 * scopes the lookup, so a cross-org id simply isn't found → 404 at the route).
 */
export async function sendReportNow(orgId: number, reportId: number): Promise<boolean> {
  const result = await tenantQuery(
    orgId,
    `SELECT id, org_id, name, cadence, day_of_week, hour_utc, channel, destination,
            suite_filter, last_sent_at
     FROM scheduled_reports
     WHERE id = $1`,
    [reportId]
  );
  const report = result.rows[0];
  if (!report) return false;

  await deliverReport(report);
  await tenantQuery(
    orgId,
    "UPDATE scheduled_reports SET last_sent_at = NOW() WHERE id = $1",
    [reportId]
  );
  return true;
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
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7778";
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
  // 10s timeout: this fetch is awaited under the advisory lock, so a
  // hung receiver would block every scheduled report across the cluster
  // until the OS eventually severs the connection (minutes, not seconds).
  // Surface non-2xx so the outer try/catch logs them — silent 500s
  // would update last_sent_at and the operator never sees the failure.
  const res = await fetch(report.destination, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(formatted),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Scheduled report POST → ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function deliverEmailReport(to: string, subject: string, body: string): Promise<void> {
  try {
    await sendEmail({ to, subject, text: body });
  } catch (err) {
    // Re-throw after logging. The caller (sendReportNow and the scheduled
    // sweep) stamps last_sent_at only when deliverReport RESOLVES. Swallowing
    // here marked a never-delivered email report as "sent", and the dedup SQL
    // (DAILY_NOT_SENT_TODAY / WEEKLY_NOT_SENT_THIS_WEEK, both keyed on
    // last_sent_at) then blocked every retry — the report was silently lost.
    // The webhook deliverer throws on non-2xx for exactly this reason.
    console.log(`[scheduled-report] email delivery failed to=${to} subject="${subject}": ${(err as Error).message}`);
    throw err;
  }
}
