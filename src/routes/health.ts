import { Router } from "express";
import { getDb } from "../lib/db.js";

export const healthRouter = Router();

// Cap the Mongo ping at 2 s so a wedged driver (e.g. an internal-DNS blip
// that never resolves) can't make /health hang — if Railway's healthcheck
// hangs, the replica may not be cycled. A timeout returns 503, which
// Railway treats as a clear failure signal.
const MONGO_PING_TIMEOUT_MS = 2_000;

// State-transition logging so an incident timeline is grep-able in the
// deploy logs without spamming a line on every Railway probe (default ~5 s).
let mongoHealthy: boolean | undefined;

/** Race a promise against a timeout. The losing promise (the slow ping) is
 *  left to settle on its own — that's fine, it doesn't keep the event loop
 *  alive past `clearTimeout`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([
    p.finally(() => { if (to) clearTimeout(to); }),
    timeoutP,
  ]);
}

// `/health` — liveness + Mongo-reachability probe. Returns 503 with a
// `checks` map on dependency failure so Railway (and any load balancer)
// can pull the replica out of rotation. The Mongo ping is bounded by
// `MONGO_PING_TIMEOUT_MS` so a wedged driver doesn't hang the route
// indefinitely. Retell/Twilio probes are intentionally NOT included — they
// cost API quota on every poll. Add `/health/deep` later if needed.
healthRouter.get("/", async (_req, res) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  try {
    await withTimeout(getDb().command({ ping: 1 }), MONGO_PING_TIMEOUT_MS, "mongo ping");
    checks.mongo = { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.mongo = { ok: false, error: msg };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  // Log only on state transitions — one "FAILED" line at the moment a
  // dependency goes down, one "recovered" line when it comes back. Avoids
  // the spam of logging every probe (Railway hits this every few seconds).
  if (mongoHealthy === undefined || mongoHealthy !== checks.mongo.ok) {
    if (checks.mongo.ok) {
      if (mongoHealthy === false) {
        console.log("[health] Mongo check recovered — returning 200");
      }
    } else {
      console.error(
        `[health] Mongo check FAILED — returning 503: ${checks.mongo.error}`,
      );
    }
    mongoHealthy = checks.mongo.ok;
  }

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks,
  });
});
