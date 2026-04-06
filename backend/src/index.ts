import express from "express";
import cors from "cors";
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
import { requireAuth } from "./auth.js";
import { runRetentionCleanup } from "./retention.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static("uploads"));

// Public routes
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/auth", authRouter);

// Protected routes
app.use("/orgs", requireAuth, orgsRouter);
app.use("/suites", requireAuth, suitesRouter);
app.use("/webhooks", requireAuth, webhooksRouter);
app.use("/audit", requireAuth, auditRouter);
app.use("/runs/upload", requireAuth, uploadsRouter);
app.use("/runs", requireAuth, runsRouter);
app.use("/errors", requireAuth, errorsRouter);
app.use("/stats", requireAuth, statsRouter);
app.use("/tests", requireAuth, testsRouter);

app.listen(PORT, () => {
  console.log(`Flakey API running on http://localhost:${PORT}`);

  // Run retention cleanup daily
  setTimeout(runRetentionCleanup, 10000);
  setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);
});
