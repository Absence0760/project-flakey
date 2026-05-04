import { Router } from "express";
import { tenantQuery } from "../db.js";
import { logAudit } from "../audit.js";

const router = Router();

type Severity = "high" | "medium" | "low" | "info";

interface IncomingFinding {
  rule_id?: string | null;
  name?: string;
  severity?: string;
  description?: string | null;
  solution?: string | null;
  url?: string | null;
  cwe?: string | null;
  instances?: number;
  metadata?: unknown;
}

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(["high", "medium", "low", "info"]);

export function normalizeSeverity(input: unknown): Severity {
  if (typeof input !== "string") return "info";
  const lower = input.toLowerCase();
  if (VALID_SEVERITIES.has(lower as Severity)) return lower as Severity;
  // Common aliases (ZAP risk labels, Trivy uppercase, etc).
  if (lower === "critical") return "high";
  if (lower === "warning" || lower === "moderate") return "medium";
  if (lower === "informational" || lower === "note") return "info";
  return "info";
}

// POST /security — ingest a security scan + findings for a run
router.post("/", async (req, res) => {
  try {
    const { run_id, scanner, target, findings, raw_report } = req.body as {
      run_id?: number;
      scanner?: string;
      target?: string;
      findings?: IncomingFinding[];
      raw_report?: unknown;
    };

    if (!run_id) {
      res.status(400).json({ error: "run_id required" });
      return;
    }
    if (!scanner || typeof scanner !== "string" || !scanner.trim()) {
      res.status(400).json({ error: "scanner required" });
      return;
    }

    const check = await tenantQuery(req.user!.orgId, "SELECT id FROM runs WHERE id = $1", [run_id]);
    if (check.rows.length === 0) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const findingList = Array.isArray(findings) ? findings : [];
    let high = 0, medium = 0, low = 0, info = 0;
    const normalized = findingList.map((f) => {
      const sev = normalizeSeverity(f.severity);
      if (sev === "high") high++;
      else if (sev === "medium") medium++;
      else if (sev === "low") low++;
      else info++;
      return {
        rule_id: typeof f.rule_id === "string" && f.rule_id.trim() ? f.rule_id : null,
        name: typeof f.name === "string" && f.name.trim() ? f.name : "(unnamed finding)",
        severity: sev,
        description: typeof f.description === "string" ? f.description : null,
        solution: typeof f.solution === "string" ? f.solution : null,
        url: typeof f.url === "string" ? f.url : null,
        cwe: typeof f.cwe === "string" ? f.cwe : null,
        instances: Number.isFinite(f.instances) && (f.instances as number) > 0 ? Math.floor(f.instances as number) : 1,
        metadata: f.metadata == null ? null : f.metadata,
      };
    });

    // Upsert the scan row (one per run+scanner — re-uploads replace findings).
    const scanRes = await tenantQuery(
      req.user!.orgId,
      `INSERT INTO security_scans
        (org_id, run_id, scanner, target, high_count, medium_count, low_count, info_count, raw_report)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (run_id, scanner) DO UPDATE SET
         target = EXCLUDED.target,
         high_count = EXCLUDED.high_count,
         medium_count = EXCLUDED.medium_count,
         low_count = EXCLUDED.low_count,
         info_count = EXCLUDED.info_count,
         raw_report = EXCLUDED.raw_report,
         created_at = NOW()
       RETURNING id, run_id, scanner, target, high_count, medium_count, low_count, info_count, created_at`,
      [
        req.user!.orgId,
        run_id,
        scanner.trim(),
        typeof target === "string" ? target : null,
        high, medium, low, info,
        raw_report == null ? null : JSON.stringify(raw_report),
      ]
    );
    const scanId = scanRes.rows[0].id as number;

    // Replace any prior findings rows for this scan; the upsert above doesn't
    // cascade-delete them (no FK trigger needed because the row count is small
    // and the operation is idempotent per run).
    await tenantQuery(req.user!.orgId, `DELETE FROM security_findings WHERE scan_id = $1`, [scanId]);

    if (normalized.length > 0) {
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const f of normalized) {
        placeholders.push(
          `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
        );
        values.push(
          scanId,
          req.user!.orgId,
          run_id,
          f.rule_id,
          f.name,
          f.severity,
          f.description,
          f.solution,
          f.url,
          f.cwe,
          f.instances,
          f.metadata == null ? null : JSON.stringify(f.metadata),
        );
      }
      await tenantQuery(
        req.user!.orgId,
        `INSERT INTO security_findings
          (scan_id, org_id, run_id, rule_id, name, severity, description, solution, url, cwe, instances, metadata)
         VALUES ${placeholders.join(", ")}`,
        values
      );
    }

    await logAudit(req.user!.orgId, req.user!.id, "security.upload", "run", String(run_id), {
      scanner: scanner.trim(),
      findings: normalized.length,
      high, medium, low, info,
    });

    res.status(201).json({
      ...scanRes.rows[0],
      findings: normalized.length,
    });
  } catch (err) {
    console.error("POST /security error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /security/runs/:runId — all scans + findings for a run
router.get("/runs/:runId", async (req, res) => {
  try {
    const scansRes = await tenantQuery(
      req.user!.orgId,
      `SELECT id, scanner, target, high_count, medium_count, low_count, info_count, created_at
       FROM security_scans WHERE run_id = $1 ORDER BY scanner`,
      [req.params.runId]
    );
    const findingsRes = await tenantQuery(
      req.user!.orgId,
      `SELECT id, scan_id, rule_id, name, severity, description, solution, url, cwe, instances, metadata
       FROM security_findings WHERE run_id = $1
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, name`,
      [req.params.runId]
    );

    const findingsByScan = new Map<number, unknown[]>();
    for (const row of findingsRes.rows) {
      if (!findingsByScan.has(row.scan_id)) findingsByScan.set(row.scan_id, []);
      findingsByScan.get(row.scan_id)!.push(row);
    }

    res.json(
      scansRes.rows.map((s: { id: number }) => ({
        ...s,
        findings: findingsByScan.get(s.id) ?? [],
      }))
    );
  } catch (err) {
    console.error("GET /security/runs/:runId error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /security/trend — recent scans across the org
router.get("/trend", async (req, res) => {
  try {
    const result = await tenantQuery(
      req.user!.orgId,
      `SELECT s.run_id, s.scanner, s.high_count, s.medium_count, s.low_count, s.info_count,
              r.suite_name, r.branch, r.created_at
       FROM security_scans s JOIN runs r ON r.id = s.run_id
       WHERE s.org_id = $1
       ORDER BY r.created_at DESC LIMIT 200`,
      [req.user!.orgId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("GET /security/trend error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
