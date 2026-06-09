import { Router } from "express";
import { createHash } from "node:crypto";
import { tenantQuery } from "../db.js";
import { analyzeCluster, analyzeFailure, analyzeFlakyTest, clusterBySimilarity, computeSimilarity, generateFixPatch, isAIEnabled, testConnection } from "../ai.js";
import { getProviderForOrg } from "../git-providers/index.js";
import { safeLog } from "../log.js";

const router = Router();

// GET /analyze/status — check if AI is enabled.
// Reads no request state (hence `_req`) and touches no tenant data: AI is
// instance-level config, identical for every org. It is intentionally NOT in
// SUPPORT_READ_BASEURLS (auth.ts), so a cross-org support session 403s here —
// support agents have no business probing instance AI configuration. If that
// ever needs to change, add "/analyze" to SUPPORT_READ_BASEURLS rather than
// loosening the guard here.
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
    // Never echo the raw error to the client — it can carry upstream provider
    // detail (auth errors, key prefixes, model names). Log server-side, return
    // a fixed string. (testConnection() already does the same internally.)
    console.error("POST /analyze/test-connection error:", safeLog(err));
    res.json({ ok: false, error: "AI provider connection failed" });
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
    console.error("POST /analyze/error error:", safeLog(err));
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
    console.error("POST /analyze/test error:", safeLog(err));
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
    console.error("POST /analyze/flaky error:", safeLog(err));
    res.status(500).json({ error: "Analysis failed" });
  }
});

// POST /analyze/similar/:fingerprint — find similar historical failures
router.post("/similar/:fingerprint", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const fingerprint = req.params.fingerprint;

    // No viewer gate here: unlike /error, /test and /flaky, this path calls no
    // model and writes no cache — it's a deterministic similarity scan over the
    // org's own errors, which a viewer can already read. (See architecture.md.)

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

    // Get other distinct errors. Dedup is by error_message (one row per
    // distinct message, regardless of suite). Both the per-message representative
    // AND the 200-row cap are made deterministic with explicit ORDER BYs —
    // otherwise `DISTINCT ON` picks an arbitrary suite/fingerprint/count for a
    // message that spans multiple suites, and `LIMIT` keeps an arbitrary subset,
    // so two identical calls could disagree (the handler is documented as a
    // deterministic scan). Inner ORDER BY → the most-recent occurrence is the
    // representative; outer ORDER BY → the most-recent messages survive the cap.
    const others = await tenantQuery(orgId,
      `SELECT fingerprint, error_message, suite_name, occurrence_count, status
       FROM (
         SELECT DISTINCT ON (t.error_message)
           md5(t.error_message || '|' || r.suite_name) AS fingerprint,
           t.error_message, r.suite_name,
           COUNT(*) OVER (PARTITION BY t.error_message, r.suite_name) AS occurrence_count,
           COALESCE(eg.status, 'open') AS status,
           r.created_at AS latest_at
         FROM tests t
         JOIN specs s ON s.id = t.spec_id
         JOIN runs r ON r.id = s.run_id
         LEFT JOIN error_groups eg ON eg.fingerprint = md5(t.error_message || '|' || r.suite_name) AND eg.org_id = r.org_id
         WHERE t.status = 'failed' AND t.error_message IS NOT NULL
           AND md5(t.error_message || '|' || r.suite_name) != $1
         ORDER BY t.error_message, r.created_at DESC, t.id DESC
       ) d
       ORDER BY d.latest_at DESC, d.fingerprint
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
    console.error("POST /analyze/similar error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

// A distinct-error row used as a clustering input. Mirrors the /similar query
// shape: one row per distinct error_message.
interface DistinctErrorRow {
  fingerprint: string;
  error_message: string;
  suite_name: string;
  occurrence_count: number;
  status: string;
}

// Truncate an error message for the cluster-member response (the full text is
// only needed for similarity scoring, done server-side before this).
function truncateMessage(msg: string): string {
  return msg.length > 300 ? msg.slice(0, 300) : msg;
}

// A cluster's cache key is a stable md5 of its SORTED member fingerprints, so
// the theme cache hits as long as membership is unchanged (even if the input
// order — and thus which member is the representative — shifts).
function clusterKey(members: DistinctErrorRow[]): string {
  const sorted = members.map((m) => m.fingerprint).sort();
  return createHash("md5").update(sorted.join(",")).digest("hex");
}

// The representative is the highest-occurrence member, tie-broken by fingerprint
// (deterministic). This is the member we label and summarize against.
function clusterRepresentative(members: DistinctErrorRow[]): DistinctErrorRow {
  return members.reduce((best, m) => {
    if (m.occurrence_count > best.occurrence_count) return m;
    if (m.occurrence_count === best.occurrence_count && m.fingerprint < best.fingerprint) return m;
    return best;
  });
}

// POST /analyze/clusters — group the org's distinct failed errors into
// root-cause clusters. The grouping is deterministic similarity (cost-free,
// works AI-off); when AI is configured each multi-member cluster gets a short
// cached "theme" label. Read-cached for everyone; generate for contributor+.
router.post("/clusters", async (req, res) => {
  try {
    const orgId = req.user!.orgId;

    // Distinct failed errors, same DISTINCT-ON shape as /similar. Deterministic
    // representative (most-recent occurrence) and deterministic 200-row cap.
    const errors = await tenantQuery(orgId,
      `SELECT fingerprint, error_message, suite_name, occurrence_count, status
       FROM (
         SELECT DISTINCT ON (t.error_message)
           md5(t.error_message || '|' || r.suite_name) AS fingerprint,
           t.error_message, r.suite_name,
           COUNT(*) OVER (PARTITION BY t.error_message, r.suite_name) AS occurrence_count,
           COALESCE(eg.status, 'open') AS status,
           r.created_at AS latest_at
         FROM tests t
         JOIN specs s ON s.id = t.spec_id
         JOIN runs r ON r.id = s.run_id
         LEFT JOIN error_groups eg ON eg.fingerprint = md5(t.error_message || '|' || r.suite_name) AND eg.org_id = r.org_id
         WHERE t.status = 'failed' AND t.error_message IS NOT NULL
         ORDER BY t.error_message, r.created_at DESC, t.id DESC
       ) d
       ORDER BY d.latest_at DESC, d.fingerprint
       LIMIT 200`,
      []
    );

    const rows: DistinctErrorRow[] = errors.rows.map((row: any) => ({
      fingerprint: row.fingerprint,
      error_message: row.error_message,
      suite_name: row.suite_name,
      occurrence_count: Number(row.occurrence_count),
      status: row.status,
    }));

    // Deterministic greedy clustering — no model calls. Threshold 0.4.
    const grouped = clusterBySimilarity(rows, (r) => r.error_message, 0.4);

    // Labeling is gated like the other analyze routes: read cached for
    // everyone, generate only for contributor+ when AI is configured. We never
    // 403 the whole endpoint — viewers / AI-off callers just get theme=null
    // (plus any already-cached themes).
    const canGenerate = isAIEnabled() && req.user!.orgRole !== "viewer";

    const clusters = [];
    for (const members of grouped) {
      const representative = clusterRepresentative(members);
      const targetKey = clusterKey(members);
      const totalOccurrences = members.reduce((sum, m) => sum + m.occurrence_count, 0);

      // Read any cached theme — a plain DB read, works regardless of AI config.
      const cached = await tenantQuery(orgId,
        `SELECT classification, summary FROM ai_analyses
         WHERE target_type = 'cluster' AND target_key = $1`,
        [targetKey]
      );

      let theme: string | null = null;
      let summary: string | null = null;
      if (cached.rows.length > 0) {
        theme = cached.rows[0].classification;
        summary = cached.rows[0].summary;
      } else if (canGenerate && members.length > 1) {
        // Skip singleton clusters — no shared theme worth a model call.
        const result = await analyzeCluster({
          representativeMessage: representative.error_message,
          sampleMessages: members.map((m) => m.error_message),
        });
        theme = result.theme;
        summary = result.summary;
        await tenantQuery(orgId,
          `INSERT INTO ai_analyses (org_id, target_type, target_key, classification, summary, raw_result)
           VALUES ($1, 'cluster', $2, $3, $4, $5)
           ON CONFLICT (org_id, target_type, target_key) DO UPDATE
           SET classification = $3, summary = $4, raw_result = $5, created_at = NOW()`,
          [orgId, targetKey, result.theme, result.summary, JSON.stringify(result)]
        );
      }

      clusters.push({
        target_key: targetKey,
        theme,
        summary,
        member_count: members.length,
        total_occurrences: totalOccurrences,
        representative_fingerprint: representative.fingerprint,
        members: members.slice(0, 20).map((m) => ({
          fingerprint: m.fingerprint,
          error_message: truncateMessage(m.error_message),
          suite_name: m.suite_name,
          occurrence_count: m.occurrence_count,
          status: m.status,
        })),
      });
    }

    res.json({ clusters });
  } catch (err) {
    console.error("POST /analyze/clusters error:", safeLog(err));
    res.status(500).json({ error: "Analysis failed" });
  }
});

// Largest file we'll feed to the model for an automated fix. Above this we
// refuse rather than truncate (a truncated file committed = a broken file).
const MAX_FIX_FILE_CHARS = 40_000;

// A fix target resolved from either a testId or a fingerprint: the file to
// patch, the failing test's title, its error message, and the
// (target_type, target_key) pair used for idempotency + the ai_fix_prs row.
interface FixTarget {
  targetType: "error" | "flaky";
  targetKey: string;
  filePath: string;
  testTitle: string;
  errorMessage: string;
}

// POST /analyze/fix-pr — open a DRAFT pull/merge request with an AI-proposed
// fix for a failing test. SAFETY: always a DRAFT, never auto-merged; bounded by
// a file-size cap; guarded against empty / unchanged / truncated model output;
// idempotent per (org, target). Contributor+ only (model call + repo write).
//
// Body: exactly one of { testId } or { fingerprint }.
router.post("/fix-pr", async (req, res) => {
  try {
    const orgId = req.user!.orgId;
    const { testId, fingerprint } = req.body ?? {};

    // Exactly one selector — reject zero or both so the target is unambiguous.
    const hasTestId = testId !== undefined && testId !== null;
    const hasFingerprint = typeof fingerprint === "string" && fingerprint.length > 0;
    if (hasTestId === hasFingerprint) {
      res.status(400).json({ error: "Provide exactly one of testId or fingerprint" });
      return;
    }

    // Cost + repo-write gate: contributor+ only.
    if (blockViewerGeneration(req, res)) return;

    // Resolve the target (file_path, title, error_message, target_type/key).
    let target: FixTarget | null = null;
    if (hasTestId) {
      const id = Number(testId);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid test id" });
        return;
      }
      // RLS scopes this to the caller's org, so a foreign id simply 404s.
      const result = await tenantQuery(orgId,
        `SELECT t.full_title, t.error_message, s.file_path, r.suite_name,
                md5(t.error_message || '|' || r.suite_name) AS fingerprint
         FROM tests t
         JOIN specs s ON s.id = t.spec_id
         JOIN runs r ON r.id = s.run_id
         WHERE t.id = $1 AND t.status = 'failed' AND t.error_message IS NOT NULL
         LIMIT 1`,
        [id]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        target = {
          targetType: "error",
          targetKey: row.fingerprint,
          filePath: row.file_path,
          testTitle: row.full_title,
          errorMessage: row.error_message,
        };
      }
    } else {
      // From a fingerprint → a representative failed test for that error group
      // (mirrors /analyze/error's resolution).
      const result = await tenantQuery(orgId,
        `SELECT t.full_title, t.error_message, s.file_path
         FROM tests t
         JOIN specs s ON s.id = t.spec_id
         JOIN runs r ON r.id = s.run_id
         WHERE t.status = 'failed' AND t.error_message IS NOT NULL
           AND md5(t.error_message || '|' || r.suite_name) = $1
         ORDER BY r.created_at DESC LIMIT 1`,
        [fingerprint]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        target = {
          targetType: "error",
          targetKey: fingerprint,
          filePath: row.file_path,
          testTitle: row.full_title,
          errorMessage: row.error_message,
        };
      }
    }

    if (!target) {
      res.status(404).json({ error: "Failed test with an error message not found" });
      return;
    }

    // A git provider must be configured to open a PR.
    const prov = await getProviderForOrg(orgId);
    if (!prov) {
      res.status(409).json({ error: "No git provider configured" });
      return;
    }

    // Generating the patch calls the model — gate on AI being enabled.
    if (!isAIEnabled()) {
      res.status(503).json({ error: "AI analysis requires an AI provider to be configured" });
      return;
    }

    // Concurrency + idempotency: CLAIM the (target) slot with an open row
    // BEFORE talking to the git provider. A partial unique index
    // (ai_fix_prs_one_open_per_target, status='open' — migration 062) means a
    // second concurrent request loses the INSERT race and returns the existing
    // PR instead of opening a duplicate against the customer's repo. The branch
    // name is deterministic from target_key, so it's known up front.
    const branch = `flakey/fix-${createHash("md5").update(target.targetKey).digest("hex").slice(0, 8)}`;
    const claim = await tenantQuery(orgId,
      `INSERT INTO ai_fix_prs (org_id, target_type, target_key, provider, branch, file_path, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, target_type, target_key) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [orgId, target.targetType, target.targetKey, prov.platform, branch, target.filePath, req.user!.id]
    );
    if (claim.rows.length === 0) {
      // Lost the race (or an open PR already exists) — return it, don't duplicate.
      const existing = await tenantQuery(orgId,
        `SELECT pr_number, pr_url, branch FROM ai_fix_prs
         WHERE target_type = $1 AND target_key = $2 AND status = 'open'
         ORDER BY created_at DESC LIMIT 1`,
        [target.targetType, target.targetKey]
      );
      const row = existing.rows[0] ?? {};
      res.json({ created: false, reason: "exists", pr_url: row.pr_url ?? null, pr_number: row.pr_number ?? null, branch: row.branch ?? null });
      return;
    }
    const claimId = claim.rows[0].id as number;
    // Free the claimed slot so a later attempt can retry (used on every early
    // return below that doesn't actually open a PR, and on provider failure).
    const releaseClaim = () =>
      tenantQuery(orgId, "DELETE FROM ai_fix_prs WHERE id = $1", [claimId]).catch(() => {});

    // Everything below talks to the git provider + the model. Wrap it so a
    // mid-way failure releases the claim and returns a generic 502 — never echo
    // provider detail/tokens.
    try {
      const base = await prov.provider.getDefaultBranch();
      const file = await prov.provider.getFileContent(target.filePath, base.sha);
      if (!file) {
        await releaseClaim();
        res.status(422).json({ error: "Target file not found in repo" });
        return;
      }
      // SIZE GUARD: don't even call the model on an oversized file.
      if (file.content.length > MAX_FIX_FILE_CHARS) {
        await releaseClaim();
        res.status(413).json({ error: "File too large for automated fix" });
        return;
      }

      const result = await generateFixPatch({
        filePath: target.filePath,
        fileContent: file.content,
        errorMessage: target.errorMessage,
        testTitle: target.testTitle,
      });

      // GUARD: empty or unchanged → don't open an empty PR.
      if (!result.content || result.content === file.content) {
        await releaseClaim();
        res.json({ created: false, reason: "no change" });
        return;
      }
      // TRUNCATION GUARD: a result less than half the original is almost
      // certainly a model truncation — never commit it.
      if (result.content.length < file.content.length * 0.5) {
        await releaseClaim();
        res.status(422).json({ error: "Generated patch looked truncated" });
        return;
      }

      // Strip control chars from the test title before it lands in a git commit
      // message / PR title (some normalizers allow newlines in full_title).
      const safeTitle = target.testTitle.replace(/[\r\n\t]+/g, " ").slice(0, 200);
      const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:7778";
      const body = [
        result.explanation,
        "",
        "---",
        "⚠️ **AI-generated — review before merging.** This change was proposed automatically by Flakey and opened as a draft. A human must review and merge it.",
        "",
        `[View the failing test in Flakey](${frontendUrl}/errors/${target.targetKey})`,
      ].join("\n");

      await prov.provider.createBranch(branch, base.sha);
      await prov.provider.commitFile({
        branch,
        path: target.filePath,
        content: result.content,
        message: `[Flakey] Proposed fix: ${safeTitle}`,
        sha: file.sha,
      });
      const pr = await prov.provider.createPullRequest({
        head: branch,
        base: base.name,
        title: `[Flakey] Proposed fix: ${safeTitle}`,
        body,
        draft: true,
      });

      // Fill the claimed row with the opened PR's details.
      await tenantQuery(orgId,
        `UPDATE ai_fix_prs SET pr_number = $1, pr_url = $2 WHERE id = $3`,
        [pr.number, pr.url, claimId]
      );

      res.json({ created: true, pr_url: pr.url, pr_number: pr.number, branch });
    } catch (err) {
      // Provider/model failure mid-flow — release the claim, log detail
      // server-side, return a fixed message so no provider token/detail reaches
      // the client.
      await releaseClaim();
      console.error("POST /analyze/fix-pr provider error:", safeLog(err));
      res.status(502).json({ error: "Failed to open fix PR" });
    }
  } catch (err) {
    console.error("POST /analyze/fix-pr error:", safeLog(err));
    res.status(500).json({ error: "Analysis failed" });
  }
});

export default router;
