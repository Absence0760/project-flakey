import express from "express";
import cors from "cors";
import runsRouter from "./routes/runs.js";
import errorsRouter from "./routes/errors.js";
import statsRouter from "./routes/stats.js";
import testsRouter from "./routes/tests.js";
import uploadsRouter from "./routes/uploads.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use("/uploads", express.static("uploads"));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/runs/upload", uploadsRouter);
app.use("/runs", runsRouter);
app.use("/errors", errorsRouter);
app.use("/stats", statsRouter);
app.use("/tests", testsRouter);

app.listen(PORT, () => {
  console.log(`Flakey API running on http://localhost:${PORT}`);
});
