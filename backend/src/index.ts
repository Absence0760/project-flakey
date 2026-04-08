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
import pool from "./db.js";
import { requireAuth } from "./auth.js";
import { runRetentionCleanup } from "./retention.js";
import { getStorage } from "./storage.js";

// Fix 1: Refuse to start without JWT_SECRET in production
const IS_PROD = process.env.NODE_ENV === "production";
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required in production.");
  process.exit(1);
}

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Fix 2: CORS whitelist — only allow configured origins (default: localhost for dev)
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:7777,http://localhost:3000")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.use(helmet({ contentSecurityPolicy: false }));
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

// Artifact serving — local disk or S3 redirect
const STORAGE_MODE = process.env.STORAGE ?? "local";
if (STORAGE_MODE === "s3") {
  app.get("/uploads/*", async (req, res) => {
    try {
      const key = req.path.replace(/^\/uploads\//, "");
      const url = await getStorage().getUrl(key);
      res.redirect(302, url);
    } catch {
      res.status(404).json({ error: "Artifact not found" });
    }
  });
} else {
  app.use("/uploads", express.static("uploads", {
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  }));
}

// Fix 3: Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // 20 attempts per window
  message: { error: "Too many attempts. Try again in 15 minutes." },
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
app.use("/auth", authLimiter, authRouter);
app.use("/badge", badgeRouter);

// Protected routes
app.use("/orgs", requireAuth, orgsRouter);
app.use("/suites", requireAuth, suitesRouter);
app.use("/webhooks", requireAuth, webhooksRouter);
app.use("/audit", requireAuth, auditRouter);
app.use("/compare", requireAuth, compareRouter);
app.use("/runs/upload", requireAuth, uploadsRouter);
app.use("/runs", requireAuth, runsRouter);
app.use("/errors", requireAuth, errorsRouter);
app.use("/flaky", requireAuth, flakyRouter);
app.use("/notes", requireAuth, notesRouter);
app.use("/stats", requireAuth, statsRouter);
app.use("/tests", requireAuth, testsRouter);
app.use("/views", requireAuth, viewsRouter);

app.listen(PORT, () => {
  console.log(`Flakey API running on http://localhost:${PORT}`);
  if (IS_PROD) console.log(`CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);

  // Run retention cleanup daily
  setTimeout(runRetentionCleanup, 10000);
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);
});
