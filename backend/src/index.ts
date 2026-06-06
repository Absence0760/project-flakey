import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import runsRouter from "./routes/runs.js";
import errorsRouter from "./routes/errors.js";
import statsRouter from "./routes/stats.js";
import testsRouter from "./routes/tests.js";
import uploadsRouter from "./routes/uploads.js";
import authRouter from "./routes/auth.js";
import orgsRouter from "./routes/orgs.js";
import suitesRouter from "./routes/suites.js";
import webhooksRouter from "./routes/webhooks.js";
import auditRouter from "./routes/audit.js";
import compareRouter from "./routes/compare.js";
import badgeRouter from "./routes/badge.js";
import flakyRouter from "./routes/flaky.js";
import notesRouter from "./routes/notes.js";
import viewsRouter from "./routes/views.js";
import analyzeRouter from "./routes/analyze.js";
import quarantineRouter from "./routes/quarantine.js";
import predictRouter from "./routes/predict.js";
import connectivityRouter from "./routes/connectivity.js";
import liveRouter from "./routes/live.js";
import jiraRouter from "./routes/jira.js";
import pagerdutyRouter from "./routes/pagerduty.js";
import reportsRouter from "./routes/reports.js";
import coverageRouter from "./routes/coverage.js";
import a11yRouter from "./routes/a11y.js";
import visualRouter from "./routes/visual.js";
import securityRouter from "./routes/security.js";
import uiCoverageRouter from "./routes/ui-coverage.js";
import manualTestsRouter from "./routes/manual-tests.js";
import manualTestGroupsRouter from "./routes/manual-test-groups.js";
import releasesRouter from "./routes/releases.js";
import supportRouter from "./routes/support.js";
import pool from "./db.js";
import { requireAuth } from "./auth.js";
import { runRetentionCleanup } from "./retention.js";
import { runScheduledReports } from "./scheduled-reports.js";
import { getStorage } from "./storage.js";
import { validateConfiguredKeys } from "./crypto.js";
import { bootstrapAdmin } from "./bootstrap-admin.js";
import { liveEvents } from "./live-events.js";

// Fix 1: Refuse to start without JWT_SECRET in production
const IS_PROD = process.env.NODE_ENV === "production";
// Lowercase alias kept for the rate-limit blocks below; same boolean.
const isProd = IS_PROD;
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required in production.");
  process.exit(1);
}

// Without FLAKEY_ENCRYPTION_KEY, crypto.ts falls back to plaintext
// passthrough — fine for local dev but means production-stored Jira
// tokens, PagerDuty keys, etc. would land on disk in clear. Refuse to
// boot in prod without it.
if (IS_PROD && !process.env.FLAKEY_ENCRYPTION_KEY) {
  console.error("FATAL: FLAKEY_ENCRYPTION_KEY is required in production. Integration secrets would otherwise be persisted as plaintext.");
  process.exit(1);
}

// Validate key FORMAT at boot — not just presence. A FLAKEY_ENCRYPTION_KEY
// that's set but malformed (wrong length, not hex/base64) silently passes
// the presence check above; crypto.ts's lazy parseKey then throws on the
// first PATCH /jira/settings, surfacing as a generic 500 + unhandled error
// log entry. Calling validateConfiguredKeys here makes the failure mode a
// clean refuse-to-boot. Same logic applied to FLAKEY_ENCRYPTION_KEY_OLD
// (key rotation companion) since a typo there silently breaks read-path
// decryption.
try {
  validateConfiguredKeys();
} catch (err) {
  console.error(`FATAL: FLAKEY_ENCRYPTION_KEY validation failed: ${(err as Error).message}`);
  process.exit(1);
}

if (IS_PROD && process.env.ALLOW_REGISTRATION === "true") {
  console.warn("WARNING: ALLOW_REGISTRATION=true — open self-registration is enabled.");
}

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Fix 2: CORS whitelist — only allow configured origins (default: localhost for dev)
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:7778,http://localhost:3000")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Strict CSP. This backend serves JSON, SVG badges, and static
// upload artifacts — none of which need to load external resources.
// Setting `default-src 'none'` means an accidentally-rendered HTML
// response (Express's default error page, a future SSR route)
// can't fetch any attacker-controlled assets on the user's behalf.
// `frame-ancestors 'none'` is the CSP-layer clickjacking defence
// that complements helmet's X-Frame-Options DENY.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  // The API is meant to be consumed by the SvelteKit SPA on a
  // different origin (port 7778 in dev, the CloudFront-served
  // frontend in prod). helmet's default `Cross-Origin-Resource-Policy:
  // same-origin` blocks the cross-origin read even when CORS allows
  // the request — the SPA gets a "Failed to fetch" with no useful
  // error. Switch to `cross-origin`; CORS (the explicit
  // ALLOWED_ORIGINS allow-list above) is the actual access gate.
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
// CORS: use the same whitelist callback in every environment.
// Previously dev used `origin: true`, which reflects the request
// Origin and (combined with credentials: true) allows any site to
// make credentialed XHRs against a dev API — also flagged by CodeQL
// js/cors-permissive-configuration. The default ALLOWED_ORIGINS
// includes the two localhost ports the dev frontend uses, so this
// stays transparent for normal dev flow.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
    else callback(new Error("CORS not allowed"));
  },
  credentials: true,
}));

app.use(express.json({ limit: "50mb" }));

// Artifact serving — local disk or S3 redirect.
//
// Artifacts are stored under runs/<runId>/{screenshots,videos,snapshots}/...
// We must:
//   1. require authentication (otherwise anyone with the URL can download
//      any artifact across the whole instance)
//   2. parse the run id from the path and verify the caller's org owns
//      that run (otherwise any authenticated user can read another org's
//      screenshots / DOM snapshots / videos by enumerating run ids).
//
// The check is applied uniformly to both the local-disk and S3 paths.
const STORAGE_MODE = process.env.STORAGE ?? "local";

async function requireRunOwnership(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  // Two artifact-key shapes are gated here:
  //   /runs/<id>/...                         — run artifacts (screenshots/snapshots/videos)
  //   /evidence/<sessionId>/<testId>/...     — release-test-session evidence
  // Each is owned via a different join; reject everything else (a
  // matching key was constructed by the upload routes, so an unknown
  // shape is either an attempt to read another artifact namespace or a
  // path-traversal smuggle).
  try {
    const { tenantQuery } = await import("./db.js");
    const runMatch = req.path.match(/^\/runs\/(\d+)\//);
    if (runMatch) {
      const runId = Number(runMatch[1]);
      const owns = await tenantQuery(req.user!.orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
      if (!owns.rowCount) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }
      next();
      return;
    }
    const evMatch = req.path.match(/^\/evidence\/(\d+)\/(\d+)\//);
    if (evMatch) {
      const sessionId = Number(evMatch[1]);
      const testId = Number(evMatch[2]);
      // The session_results row exists only inside the caller's org
      // because release_test_session_results has FORCE RLS keyed on org_id.
      const owns = await tenantQuery(
        req.user!.orgId,
        `SELECT 1 FROM release_test_session_results
          WHERE session_id = $1 AND manual_test_id = $2`,
        [sessionId, testId],
      );
      if (!owns.rowCount) {
        res.status(404).json({ error: "Artifact not found" });
        return;
      }
      next();
      return;
    }
    res.status(404).json({ error: "Artifact not found" });
  } catch (err) {
    console.error("Artifact ownership check error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// `<img>` tags can't attach an Authorization header, so artifact URLs in
// the frontend embed `?token=<jwt-or-api-key>` (mirrors the SSE /live
// route's pattern).  Promote the query token to a Bearer header so
// requireAuth can validate it.
const promoteUploadToken: express.RequestHandler = (req, _res, next) => {
  const t = req.query.token;
  if (typeof t === "string" && t && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${t}`;
  }
  next();
};

// Per-IP rate limiter on artifact serving — high cap (a release page
// renders dozens of screenshots) but bounds an enumeration sweep.
// Declared inline because /uploads is mounted before the global limiter
// and we want a tighter cap here regardless of mode.
const artifactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ARTIFACT_RATE_LIMIT_MAX ?? (isProd ? 3000 : 100000)),
  message: { error: "Artifact rate limit exceeded. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

if (STORAGE_MODE === "s3") {
  // Express 5 / path-to-regexp v8 rejects bare `*` — must be a named
  // splat. `app.use("/uploads", ...)` is equivalent (the prefix is
  // stripped from req.path before the handler runs) and lets the same
  // middleware chain that wraps express.static below cover both modes.
  app.use(
    "/uploads",
    artifactLimiter,
    promoteUploadToken,
    requireAuth,
    requireRunOwnership,
    async (req, res) => {
      try {
        // requireRunOwnership saw the prefix-stripped path (e.g.
        // `/runs/42/screenshots/foo.png`); strip the leading slash to
        // get the storage key the S3 backend expects.
        const key = req.path.replace(/^\//, "");
        const url = await getStorage().getUrl(key);
        res.redirect(302, url);
      } catch {
        res.status(404).json({ error: "Artifact not found" });
      }
    },
  );
} else {
  app.use(
    "/uploads",
    artifactLimiter,
    promoteUploadToken,
    requireAuth,
    requireRunOwnership,
    express.static("uploads", {
      setHeaders: (res) => {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      },
    })
  );
}

// Fix 3: Rate limiting.
//
// Three tiers, all mounted at the app level so every downstream router
// is covered without per-route boilerplate (also satisfies CodeQL's
// js/missing-rate-limiting rule across the whole API surface):
//
//   - authLimiter   — per-IP throttle on the unauth'd auth endpoints
//                     (login / register / password reset). Lowest cap;
//                     this is the primary credential-stuffing defence.
//   - uploadLimiter — per-IP cap on /runs/upload, which writes large
//                     files to disk or S3. Tighter than the global
//                     limiter because each request is expensive.
//   - globalLimiter — wide safety net on every other authenticated
//                     route. Cap is high enough that normal interactive
//                     use never trips it; intent is to bound a runaway
//                     script or an account compromise from generating
//                     unbounded load. /health is explicitly excluded
//                     so a load balancer's health probes don't count
//                     against the bucket.
//
// All caps loosen in non-production to keep e2e suites + iterative
// dev work unblocked. Overrides via AUTH_RATE_LIMIT_MAX /
// UPLOAD_RATE_LIMIT_MAX / API_RATE_LIMIT_MAX.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? (isProd ? 20 : 500)),
  message: { error: "Too many attempts. Try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX ?? (isProd ? 200 : 5000)),
  message: { error: "Upload rate limit exceeded. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX ?? (isProd ? 1500 : 50000)),
  message: { error: "API rate limit exceeded. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
// /health gets its own very-loose limiter. ALB target-group probes hit
// it every 30s from a small pool of ELB-internal IPs, so the limit
// has to be high enough that even those probes never trip it. The
// point isn't to limit legitimate probes — it's to bound an attacker
// flooding a single IP with /health requests to amplify DB load.
const healthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.HEALTH_RATE_LIMIT_MAX ?? 600),
  message: { error: "Health endpoint rate limit exceeded." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public routes
app.get("/health", healthLimiter, async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "degraded", error: "database unreachable" });
  }
});

// Global rate limiter — applied to every route below this point.
// /health above is intentionally outside the bucket so load-balancer
// probes don't count against it.
app.use(globalLimiter);

// Rate limit only unauthenticated auth endpoints (login, register, password reset).
// /refresh + /logout don't require a valid bearer (they read the
// refresh-token cookie/body) so they're reachable without auth and
// need the same per-IP throttle to keep cookie-replay grinding out
// of the picture.
app.use("/auth/login", authLimiter);
app.use("/auth/register", authLimiter);
app.use("/auth/forgot-password", authLimiter);
app.use("/auth/reset-password", authLimiter);
app.use("/auth/resend-verification", authLimiter);
app.use("/auth/verify-email", authLimiter);
app.use("/auth/refresh", authLimiter);
app.use("/auth/logout", authLimiter);
// /auth is mounted WITHOUT requireAuth at the router level because the
// router mixes public endpoints (login, register, forgot-password,
// reset-password, resend-verification, verify-email, refresh, logout,
// registration-status) with protected endpoints. Each protected handler
// attaches requireAuth individually (search authRouter for `requireAuth,`
// — currently `/me`, `/switch-org`, `/api-keys` GET/POST/DELETE).
// When adding a new handler to authRouter, decide explicitly whether
// to gate it; the absence of router-level requireAuth means the
// default is PUBLIC.
app.use("/auth", authRouter);
// /badge is intentionally public — shields.io-style embeddable SVG
// badges (`/badge/:orgSlug/:suiteName.svg`) must be reachable from
// Markdown / GitHub READMEs that can't carry an Authorization header.
// The badge route's only data source is a (org_slug, suite_name)
// composite key; no tenant data leaks beyond pass/fail/count totals.
app.use("/badge", badgeRouter);

// Protected routes
app.use("/orgs", requireAuth, orgsRouter);
app.use("/suites", requireAuth, suitesRouter);
app.use("/webhooks", requireAuth, webhooksRouter);
app.use("/audit", requireAuth, auditRouter);
app.use("/compare", requireAuth, compareRouter);
app.use("/runs/upload", uploadLimiter, requireAuth, uploadsRouter);
app.use("/runs", requireAuth, runsRouter);
app.use("/errors", requireAuth, errorsRouter);
app.use("/flaky", requireAuth, flakyRouter);
app.use("/notes", requireAuth, notesRouter);
app.use("/stats", requireAuth, statsRouter);
app.use("/tests", requireAuth, testsRouter);
app.use("/views", requireAuth, viewsRouter);
app.use("/analyze", requireAuth, analyzeRouter);
app.use("/quarantine", requireAuth, quarantineRouter);
app.use("/predict", requireAuth, predictRouter);
app.use("/connectivity", requireAuth, connectivityRouter);
app.use("/jira", requireAuth, jiraRouter);
app.use("/pagerduty", requireAuth, pagerdutyRouter);
app.use("/reports", requireAuth, reportsRouter);
app.use("/coverage", requireAuth, coverageRouter);
app.use("/a11y", requireAuth, a11yRouter);
app.use("/visual", requireAuth, visualRouter);
app.use("/security", requireAuth, securityRouter);
app.use("/ui-coverage", requireAuth, uiCoverageRouter);
app.use("/manual-tests", requireAuth, manualTestsRouter);
app.use("/manual-test-groups", requireAuth, manualTestGroupsRouter);
app.use("/releases", requireAuth, releasesRouter);
// Cross-org support access (mint a read-only "view as org" token). requireAuth
// blocks isSupportRead sessions from reaching this router (not on the read
// allow-list + POST-only), so only a normal support-user session can mint.
app.use("/support", requireAuth, supportRouter);
// Live events — POST requires normal auth, GET stream accepts token as query param (for EventSource)
app.use("/live", (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, requireAuth, liveRouter);

app.listen(PORT, () => {
  console.log(`Flakey API running on http://localhost:${PORT}`);
  if (IS_PROD) console.log(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);

  // Cross-task live fan-out: open the Postgres LISTEN connection so live
  // events + active-set deltas reach SSE clients on any ECS task (the bus
  // is otherwise in-process only). Safe with a single task too — a task
  // ignores its own NOTIFYs.
  liveEvents.startListener();

  // Env-gated first-admin bootstrap. No-ops unless both
  // FLAKEY_BOOTSTRAP_ADMIN_EMAIL and FLAKEY_BOOTSTRAP_ADMIN_PASSWORD are
  // set (see src/bootstrap-admin.ts). Run after migrations would have
  // applied; a failure here is surfaced loudly but doesn't take the
  // server down — the rest of the API stays available.
  bootstrapAdmin(pool).catch((err) => {
    console.error("Bootstrap admin failed:", err);
  });

  // Run retention cleanup daily
  setTimeout(runRetentionCleanup, 10000);
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);

  // Scheduled reports — check every 30 minutes
  setTimeout(runScheduledReports, 20000);
  setInterval(runScheduledReports, 30 * 60 * 1000);
});
