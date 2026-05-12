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
import pool from "./db.js";
import { requireAuth } from "./auth.js";
import { runRetentionCleanup } from "./retention.js";
import { runScheduledReports } from "./scheduled-reports.js";
import { getStorage } from "./storage.js";

// Fix 1: Refuse to start without JWT_SECRET in production
const IS_PROD = process.env.NODE_ENV === "production";
// Lowercase alias kept for the rate-limit blocks below; same boolean.
const isProd = IS_PROD;
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required in production.");
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
}));
app.use(cors({
  origin: IS_PROD
    ? (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) callback(null, true);
        else callback(new Error("CORS not allowed"));
      }
    : true, // Allow all in development
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
  // Path looks like /uploads/runs/<id>/<rest>; extract the id and verify
  // the caller's org owns it.
  const m = req.path.match(/^\/runs\/(\d+)\//);
  if (!m) {
    res.status(404).json({ error: "Artifact not found" });
    return;
  }
  const runId = Number(m[1]);
  try {
    const { tenantQuery } = await import("./db.js");
    const owns = await tenantQuery(req.user!.orgId, "SELECT 1 FROM runs WHERE id = $1", [runId]);
    if (!owns.rowCount) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    next();
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
  app.get("/uploads/*", artifactLimiter, promoteUploadToken, requireAuth, requireRunOwnership, async (req, res) => {
    try {
      const key = req.path.replace(/^\/uploads\//, "");
      const url = await getStorage().getUrl(key);
      res.redirect(302, url);
    } catch {
      res.status(404).json({ error: "Artifact not found" });
    }
  });
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

// Public routes
app.get("/health", async (_req, res) => {
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

// Rate limit only unauthenticated auth endpoints (login, register, password reset)
app.use("/auth/login", authLimiter);
app.use("/auth/register", authLimiter);
app.use("/auth/forgot-password", authLimiter);
app.use("/auth/reset-password", authLimiter);
app.use("/auth/resend-verification", authLimiter);
app.use("/auth", authRouter);
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

  // Run retention cleanup daily
  setTimeout(runRetentionCleanup, 10000);
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);

  // Scheduled reports — check every 30 minutes
  setTimeout(runScheduledReports, 20000);
  setInterval(runScheduledReports, 30 * 60 * 1000);
});
