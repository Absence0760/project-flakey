import pool from "../db.js";
import { decryptSecret } from "../crypto.js";
import type { NormalizedRun } from "../types.js";

export interface PagerDutyConfig {
  integrationKey: string;
  severity: "critical" | "error" | "warning" | "info";
  autoTrigger: boolean;
}

async function getPagerDutyConfig(orgId: number): Promise<PagerDutyConfig | null> {
  const result = await pool.query(
    `SELECT pagerduty_integration_key, pagerduty_severity, pagerduty_auto_trigger
     FROM organizations WHERE id = $1`,
    [orgId]
  );
  const row = result.rows[0];
  if (!row?.pagerduty_integration_key) return null;
  const sev = (row.pagerduty_severity ?? "error") as PagerDutyConfig["severity"];
  return {
    integrationKey: decryptSecret(row.pagerduty_integration_key)!,
    severity: ["critical", "error", "warning", "info"].includes(sev) ? sev : "error",
    autoTrigger: !!row.pagerduty_auto_trigger,
  };
}

export async function triggerPagerDutyEvent(
  integrationKey: string,
  summary: string,
  severity: PagerDutyConfig["severity"],
  source: string,
  dedupKey: string,
  customDetails: Record<string, unknown> = {}
): Promise<{ ok: boolean; status: number; dedup_key?: string }> {
  try {
    // 10s timeout: this is awaited from the post-upload pipeline
    // (maybeTriggerPagerDutyForRun → triggerPagerDutyEvent), so a hung
    // PagerDuty events API stalls every upload's post-processing.
    const res = await fetch("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: integrationKey,
        event_action: "trigger",
        dedup_key: dedupKey,
        payload: {
          summary: summary.slice(0, 1024),
          source,
          severity,
          custom_details: customDetails,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { dedup_key?: string };
    return { ok: res.ok, status: res.status, dedup_key: data.dedup_key };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function maybeTriggerPagerDutyForRun(
  orgId: number,
  runId: number,
  run: NormalizedRun
): Promise<void> {
  try {
    const cfg = await getPagerDutyConfig(orgId);
    if (!cfg || !cfg.autoTrigger) return;
    if (run.stats.failed === 0) return;

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7777";

    await triggerPagerDutyEvent(
      cfg.integrationKey,
      `[${run.meta.suite_name}] ${run.stats.failed} failed tests on ${run.meta.branch}`,
      cfg.severity,
      `flakey/${run.meta.suite_name}`,
      `flakey-${orgId}-${run.meta.suite_name}-${run.meta.branch}`,
      {
        run_id: runId,
        suite: run.meta.suite_name,
        branch: run.meta.branch,
        commit: run.meta.commit_sha,
        failed: run.stats.failed,
        passed: run.stats.passed,
        total: run.stats.total,
        run_url: `${frontendUrl}/runs/${runId}`,
      }
    );
  } catch (err) {
    console.error("maybeTriggerPagerDutyForRun error:", err);
  }
}
