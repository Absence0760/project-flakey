import { Router } from "express";
import { tenantQuery } from "../db.js";
import { analyzeFailure, analyzeFlakyTest, computeSimilarity, isAIEnabled, testConnection } from "../ai.js";

const router = Router();

// GET /analyze/status — check if AI is enabled
router.get("/status", (_req, res) => {
  res.json({ enabled: isAIEnabled() });
});

// POST /analyze/test-connection — test AI provider connectivity.
// Admin/owner-only: it triggers an outbound provider call and exposes the
// instance AI config (provider/model), matching the /connectivity probes.
router.post("/test-connection", async (req, res) => {
  try {
    const role = req.user!.orgRole;
    if (role !== "owner" && role !== "admin") {
      res.status(403).json({ error: "Admin or owner role required" });
      return;
    }
    if (!isAIEnabled()) {
      res.json({ ok: false, error: "No AI provider configured" });
      return;
    }
    const result = await testConnection();
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : "Connection failed" });
  }
});

// An error row sufficient to drive analyzeFailure(), plus its fingerprint.
interface ErrorRow {
  error_message: string;
  error_stack: string | null;
  full_title: string;
  file_path: string;
  test_code: string | null;
  suite_name: string;
}

// The shape every error-analysis response returns — matches the frontend
// AIAnalysis interface. (Deliberately a subset of the DB row: id, org_id,
// raw_result and created_at are not part of the client contract.)
function shapeErrorAnalysis(fingerprint: string, a: {
  classification: string; summary: string; suggested_fix: string; confidence: number;
}) {
  return {
    target_type: "error",
    target_key: fingerprint,
    classification: a.classification,
    summary: a.summary,
    suggested_fix: a.suggested_fix,
    confidence: a.confidence,
  };
}

// Return a cached error analysis for this fingerprint, or null on a miss.
// A plain DB read — works regardless of whether the AI provider is configured.
async function cachedErrorAnalysis(orgId: number, fingerprint: string) {
  const cached = await tenantQuery(orgId,
    `SELECT classification, summary, suggested_fix, confidence
     FROM ai_analyses WHERE target_type = 'error' AND target_key = $1`,
    [fingerprint]
  );
  return cached.rows.length > 0 ? shapeErrorAnalysis(fingerprint, cached.rows[0]) : null;
}

// Call the model for this error row and upsert the cache. Caller is responsible
// for the cache-hit short-circuit and the isAIEnabled() gate beforehand.
async function generateErrorAnalysis(orgId: number, fingerprint: string, row: ErrorRow) {
  const result = await analyzeFailure({
    errorMessage: row.error_message,
    errorStack: row.error_stack ?? undefined,
    testTitle: row.full_title,
    filePath: row.file_path,
    testCode: row.test_code ?? undefined,
    suiteName: row.suite_name,
  });
  await tenantQuery(orgId,
    `INSERT INTO ai_analyses (org_id, target_type, target_key, classification, summary, suggested_fix, confidence, raw_result)
     VALUES ($1, 'error', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, target_type, target_key) DO UPDATE
     SET classification = $3, summary = $4, suggested_fix = $5, confidence = $6, raw_result = $7, created_at = NOW()`,
    [orgId, fingerprint, result.classification, result.summary, result.suggestedFix, result.confidence, JSON.stringify(result)]
  );
  return shapeErrorAnalysis(fingerprint, {
    classification: result.classification,
    summary: result.summary,
    suggested_fix: result.suggestedFix,
    confidence: result.confidence,
  });
}

// `?refresh=true` forces a fresh model call, replacing any cached analysis —
// used by the "Re-analyze" affordance and to regenerate rows left stale by an
// older analysis format. Requires AI to be configured (a refresh can't be
// served from cache by definition).
function wantsRefresh(req: { query: Record<string, unknown> }): boolean {
  return req.query.refresh === "true";
}

// Generating an analysis calls the model (cost) and writes the cache, so it's
// gated to contributor+ — viewers can still read any cached analysis (the
// cache-hit short-circuits above run for everyone). Returns true and writes a
// 403 when the caller is a viewer; callers must `return` on true.
function blockViewerGeneration(req: { user?: { orgRole: string } }, res: {
  status: (code: number) => { json: (body: unknown) => void };
}): boolean {
  if (req.user?.orgRole === "viewer") {
    res.status(403).json({ error: "Contributor role required to generate AI analysis" });
    return true;
  }
  return false;
}

// POST /analyze/error/:fingerprint — analyze an error group (aggregated view)
router.post("/error/:fingerprint", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    if (!wantsRefresh(req)) {
      const cached = await cachedErrorAnalysis(orgId, fingerprint);
      if (cached) {
        res.json(cached);
        return;
      }
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

    if (blockViewerGeneration(req, res)) return;

    // Only now, when we're about to call the model, gate on AI being enabled —
    // so an unknown fingerprint 404s and a cached hit returns even with AI off.
    if (!isAIEnabled()) {
      res.status(503).json({ error: "AI analysis requires an AI provider to be configured" });
      return;
    }

    res.json(await generateErrorAnalysis(orgId, fingerprint, errorResult.rows[0]));
  } catch (err) {
    console.error("POST /analyze/error error:", err);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// POST /analyze/test/:testId — analyze a specific failed test (test-detail modal).
// Resolves the test to the SAME error fingerprint the aggregated /errors view
// uses, so analysis is computed once and shared between both surfaces.
router.post("/test/:testId", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const testId = Number(req.params.testId);
    if (!Number.isInteger(testId) || testId <= 0) {
      res.status(400).json({ error: "Invalid test id" });
      return;
    }

    // RLS scopes this to the caller's org, so a foreign test id simply 404s.
    const testResult = await tenantQuery(orgId,
      `SELECT t.error_message, t.error_stack, t.full_title, t.test_code,
              s.file_path, r.suite_name,
              md5(t.error_message || '|' || r.suite_name) AS fingerprint
       FROM tests t
       JOIN specs s ON s.id = t.spec_id
       JOIN runs r ON r.id = s.run_id
       WHERE t.id = $1 AND t.status = 'failed' AND t.error_message IS NOT NULL
       LIMIT 1`,
      [testId]
    );

    if (testResult.rows.length === 0) {
      res.status(404).json({ error: "Failed test with an error message not found" });
      return;
    }

    const fingerprint = testResult.rows[0].fingerprint as string;

    if (!wantsRefresh(req)) {
      const cached = await cachedErrorAnalysis(orgId, fingerprint);
      if (cached) {
        res.json(cached);
        return;
      }
    }

    if (blockViewerGeneration(req, res)) return;

    if (!isAIEnabled()) {
      res.status(503).json({ error: "AI analysis requires an AI provider to be configured" });
      return;
    }

    res.json(await generateErrorAnalysis(orgId, fingerprint, testResult.rows[0]));
  } catch (err) {
    console.error("POST /analyze/test error:", err);
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Reshape a cached flaky-analysis row into the same response the fresh-
// generation path returns (target_type/target_key + the FlakyAnalysis fields).
// The flaky columns are reused generically: classification=severity,
// summary=rootCause, suggested_fix=stabilizationSuggestion,
// confidence=shouldQuarantine. Deliberately omits id/org_id/raw_result/
// created_at — none are part of the client contract.
function shapeFlakyAnalysis(cacheKey: string, row: {
  classification: string; summary: string; suggested_fix: string; confidence: number | string;
}) {
  return {
    target_type: "flaky",
    target_key: cacheKey,
    severity: row.classification,
    rootCause: row.summary,
    stabilizationSuggestion: row.suggested_fix,
    // confidence is NUMERIC(3,2) → the pg driver hands it back as a string; the
    // flaky path stored shouldQuarantine as 1/0 in it, so coerce before testing.
    shouldQuarantine: Number(row.confidence) === 1,
  };
}

// POST /analyze/flaky — analyze a flaky test
router.post("/flaky", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const { fullTitle, filePath, suiteName, flakyRate, flipCount, totalRuns, timeline } = req.body;

    // Validate input before anything else, so a malformed request gets a 400
    // whether or not the AI provider is configured.
    if (!fullTitle) {
      res.status(400).json({ error: "fullTitle is required" });
      return;
    }

    const cacheKey = `${fullTitle}|${suiteName}`;

    // Serve a cached analysis if present — a plain DB read, no AI required.
    // Select only the contract columns and reshape them to match the
    // freshly-generated response below; never return id/org_id/raw_result/
    // created_at (raw_result echoes the prompt's error text — see shaper).
    const cached = await tenantQuery(orgId,
      `SELECT classification, summary, suggested_fix, confidence
       FROM ai_analyses WHERE target_type = 'flaky' AND target_key = $1`,
      [cacheKey]
    );
    if (cached.rows.length > 0) {
      res.json(shapeFlakyAnalysis(cacheKey, cached.rows[0]));
      return;
    }

    if (blockViewerGeneration(req, res)) return;

    // Gate on AI only when we're about to call the model.
    if (!isAIEnabled()) {
      res.status(503).json({ error: "AI analysis requires an AI provider to be configured" });
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
