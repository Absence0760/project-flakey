import { Router } from "express";
import { tenantQuery } from "../db.js";
import { analyzeFailure, analyzeFlakyTest, computeSimilarity, isAIEnabled } from "../ai.js";

const router = Router();

// GET /analyze/status — check if AI is enabled
router.get("/status", (_req, res) => {
  res.json({ enabled: isAIEnabled() });
});

// POST /analyze/error/:fingerprint — analyze an error group
router.post("/error/:fingerprint", async (req, res) => {
  try {
    if (!isAIEnabled()) {
      res.status(503).json({ error: "AI analysis requires ANTHROPIC_API_KEY to be configured" });
      return;
    }

    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    // Check cache
    const cached = await tenantQuery(orgId,
      "SELECT * FROM ai_analyses WHERE target_type = 'error' AND target_key = $1",
      [fingerprint]
    );
    if (cached.rows.length > 0) {
      res.json(cached.rows[0]);
      return;
    }

    // Get error details
    const errorResult = await tenantQuery(orgId,
      `SELECT t.error_message, t.error_stack, t.full_title, t.test_code,
              s.file_path, r.suite_name
       FROM tests t
       JOIN specs s ON s.id = t.spec_id
       JOIN runs r ON r.id = s.run_id
       WHERE t.status = 'failed' AND t.error_message IS NOT NULL
         AND md5(t.error_message || '|' || r.suite_name) = $1
       ORDER BY r.created_at DESC LIMIT 1`,
      [fingerprint]
    );

    if (errorResult.rows.length === 0) {
      res.status(404).json({ error: "Error not found" });
      return;
    }

    const err = errorResult.rows[0];
    const result = await analyzeFailure({
      errorMessage: err.error_message,
      errorStack: err.error_stack ?? undefined,
      testTitle: err.full_title,
      filePath: err.file_path,
      testCode: err.test_code ?? undefined,
      suiteName: err.suite_name,
    });

    // Cache result
    await tenantQuery(orgId,
      `INSERT INTO ai_analyses (org_id, target_type, target_key, classification, summary, suggested_fix, confidence, raw_result)
       VALUES ($1, 'error', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, target_type, target_key) DO UPDATE
       SET classification = $3, summary = $4, suggested_fix = $5, confidence = $6, raw_result = $7, created_at = NOW()`,
      [orgId, fingerprint, result.classification, result.summary, result.suggestedFix, result.confidence, JSON.stringify(result)]
    );

    res.json({
      target_type: "error",
      target_key: fingerprint,
      classification: result.classification,
      summary: result.summary,
      suggested_fix: result.suggestedFix,
      confidence: result.confidence,
    });
  } catch (err) {
    console.error("POST /analyze/error error:", err);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// POST /analyze/flaky — analyze a flaky test
router.post("/flaky", async (req, res) => {
  try {
    if (!isAIEnabled()) {
      res.status(503).json({ error: "AI analysis requires ANTHROPIC_API_KEY to be configured" });
      return;
    }

    const orgId = req.user!.orgId;
    const { fullTitle, filePath, suiteName, flakyRate, flipCount, totalRuns, timeline } = req.body;

    if (!fullTitle) {
      res.status(400).json({ error: "fullTitle is required" });
      return;
    }

    const cacheKey = `${fullTitle}|${suiteName}`;

    // Check cache
    const cached = await tenantQuery(orgId,
      "SELECT * FROM ai_analyses WHERE target_type = 'flaky' AND target_key = $1",
      [cacheKey]
    );
    if (cached.rows.length > 0) {
      res.json(cached.rows[0]);
      return;
    }

    // Get test code and recent errors
    const testInfo = await tenantQuery(orgId,
      `SELECT t.test_code, t.error_message
       FROM tests t
       JOIN specs s ON s.id = t.spec_id
       JOIN runs r ON r.id = s.run_id
       WHERE t.full_title = $1 AND r.suite_name = $2 AND t.status = 'failed' AND t.error_message IS NOT NULL
       ORDER BY r.created_at DESC LIMIT 5`,
      [fullTitle, suiteName]
    );

    const result = await analyzeFlakyTest({
      testTitle: fullTitle,
      filePath: filePath ?? "",
      flakyRate: flakyRate ?? 0,
      flipCount: flipCount ?? 0,
      totalRuns: totalRuns ?? 0,
      timeline: timeline ?? [],
      testCode: testInfo.rows[0]?.test_code ?? undefined,
      recentErrors: testInfo.rows.map((r: any) => r.error_message).filter(Boolean),
    });

    // Cache result
    await tenantQuery(orgId,
      `INSERT INTO ai_analyses (org_id, target_type, target_key, classification, summary, suggested_fix, confidence, raw_result)
       VALUES ($1, 'flaky', $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, target_type, target_key) DO UPDATE
       SET classification = $3, summary = $4, suggested_fix = $5, confidence = $6, raw_result = $7, created_at = NOW()`,
      [orgId, cacheKey, result.severity, result.rootCause, result.stabilizationSuggestion,
       result.shouldQuarantine ? 1 : 0, JSON.stringify(result)]
    );

    res.json({
      target_type: "flaky",
      target_key: cacheKey,
      ...result,
    });
  } catch (err) {
    console.error("POST /analyze/flaky error:", err);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// POST /analyze/similar/:fingerprint — find similar historical failures
router.post("/similar/:fingerprint", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    // Get the target error message
    const target = await tenantQuery(orgId,
      `SELECT t.error_message, r.suite_name
       FROM tests t JOIN specs s ON s.id = t.spec_id JOIN runs r ON r.id = s.run_id
       WHERE t.status = 'failed' AND t.error_message IS NOT NULL
         AND md5(t.error_message || '|' || r.suite_name) = $1
       LIMIT 1`,
      [fingerprint]
    );

    if (target.rows.length === 0) {
      res.status(404).json({ error: "Error not found" });
      return;
    }

    const targetMessage = target.rows[0].error_message;

    // Get other distinct errors
    const others = await tenantQuery(orgId,
      `SELECT DISTINCT ON (t.error_message)
        md5(t.error_message || '|' || r.suite_name) AS fingerprint,
        t.error_message, r.suite_name,
        COUNT(*) OVER (PARTITION BY t.error_message, r.suite_name) AS occurrence_count,
        COALESCE(eg.status, 'open') AS status
       FROM tests t
       JOIN specs s ON s.id = t.spec_id
       JOIN runs r ON r.id = s.run_id
       LEFT JOIN error_groups eg ON eg.fingerprint = md5(t.error_message || '|' || r.suite_name) AND eg.org_id = r.org_id
       WHERE t.status = 'failed' AND t.error_message IS NOT NULL
         AND md5(t.error_message || '|' || r.suite_name) != $1
       LIMIT 200`,
      [fingerprint]
    );

    const similar = others.rows
      .map((row: any) => ({
        fingerprint: row.fingerprint,
        error_message: row.error_message,
        suite_name: row.suite_name,
        occurrence_count: Number(row.occurrence_count),
        status: row.status,
        similarity: computeSimilarity(targetMessage, row.error_message),
      }))
      .filter((r: any) => r.similarity > 0.3)
      .sort((a: any, b: any) => b.similarity - a.similarity)
      .slice(0, 10);

    res.json(similar);
  } catch (err) {
    console.error("POST /analyze/similar error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
