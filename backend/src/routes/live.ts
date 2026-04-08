import { Router } from "express";
import { liveEvents, type LiveTestEvent } from "../live-events.js";

const router = Router();

/**
 * POST /live/:runId/events — receive live test events from reporters.
 * Body: LiveTestEvent or LiveTestEvent[]
 */
router.post("/:runId/events", (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  const events: LiveTestEvent[] = Array.isArray(req.body) ? req.body : [req.body];

  for (const event of events) {
    liveEvents.emit(runId, { ...event, runId, timestamp: event.timestamp ?? Date.now() });
  }

  res.json({ ok: true, listeners: liveEvents.hasListeners(runId) });
});

/**
 * GET /live/:runId/stream — SSE endpoint for live test events.
 * Browsers/frontends connect here to receive real-time updates.
 */
router.get("/:runId/stream", (req, res) => {
  const runId = Number(req.params.runId);
  if (!runId) {
    res.status(400).json({ error: "Invalid run ID" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });

  // Send initial ping
  res.write("data: {\"type\":\"connected\"}\n\n");

  const emitter = liveEvents.getEmitter(runId);

  const handler = (event: LiveTestEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  emitter.on("event", handler);

  // Keep-alive every 15 seconds
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    emitter.off("event", handler);
    clearInterval(keepAlive);
  });
});

export default router;
