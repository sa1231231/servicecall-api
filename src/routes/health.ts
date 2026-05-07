import { Router } from "express";
import { getDb } from "../lib/db.js";

export const healthRouter = Router();

// `/health` — quick liveness check. Confirms the process is running and
// can reach MongoDB. Returns 503 with a `checks` map on dependency failure
// so a load balancer can pull the instance out of rotation. Retell/Twilio
// probes are intentionally NOT included here — they cost API quota and
// rate-limit on every poll. Add `/health/deep` later if needed.
healthRouter.get("/", async (_req, res) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  try {
    await getDb().command({ ping: 1 });
    checks.mongo = { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.mongo = { ok: false, error: msg };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks,
  });
});
