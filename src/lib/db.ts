import { MongoClient, type Db } from "mongodb";
import { config } from "../config.js";

let db: Db;

// Watchdog: if Mongo heartbeats fail continuously for this long without a
// single success, exit so Railway restarts the replica. The driver's retry
// loop never gives up — without this, a runtime DNS / network outage leaves
// the process alive but unable to serve any DB-touching request, as
// happened on 2026-05-20. Logged loudly on transition so incidents are
// grep-able in deploy logs.
const MONGO_OUTAGE_THRESHOLD_MS = 60_000;
const MONGO_WATCHDOG_INTERVAL_MS = 15_000;

let lastHeartbeatSuccessAt = Date.now();
let mongoHealthy: boolean | undefined;

/** Exit the process so Railway respawns a fresh replica. Factored out so
 *  it can be patched in tests; production calls `process.exit(1)`. */
function exitOnMongoOutage(message: string): void {
  console.error(`[db] ${message} — exiting (exit 1) so Railway restarts the replica`);
  process.exit(1);
}

export async function initDb(): Promise<Db> {
  const client = new MongoClient(config.MONGODB_URL);

  // Heartbeat listeners drive both the transition log AND the watchdog.
  // The driver emits one of these every few seconds for each server in the
  // topology — failures keep firing even while the retry loop spins.
  lastHeartbeatSuccessAt = Date.now();

  client.on("serverHeartbeatSucceeded", () => {
    lastHeartbeatSuccessAt = Date.now();
    if (mongoHealthy === false) {
      console.log("[db] MongoDB heartbeats recovered");
    }
    mongoHealthy = true;
  });

  client.on("serverHeartbeatFailed", (event) => {
    const now = Date.now();
    const reason =
      (event as { failure?: { message?: string } })?.failure?.message ??
      String((event as { failure?: unknown })?.failure ?? "unknown");
    if (mongoHealthy !== false) {
      // First failure in a streak — log loudly so the incident is timestamped.
      console.error(`[db] MongoDB heartbeat FAILED — ${reason}`);
      mongoHealthy = false;
    }
    if (now - lastHeartbeatSuccessAt > MONGO_OUTAGE_THRESHOLD_MS) {
      exitOnMongoOutage(
        `MongoDB unreachable for ${Math.round((now - lastHeartbeatSuccessAt) / 1000)}s (last reason: ${reason})`,
      );
    }
  });

  // Defensive: if the driver wedges and stops firing heartbeat events at
  // all, neither the success nor the failed handler triggers. A periodic
  // poll catches that edge case. .unref() so normal shutdowns aren't held
  // up by this timer.
  setInterval(() => {
    if (Date.now() - lastHeartbeatSuccessAt > MONGO_OUTAGE_THRESHOLD_MS) {
      exitOnMongoOutage(
        `MongoDB no heartbeat success for ${Math.round((Date.now() - lastHeartbeatSuccessAt) / 1000)}s (driver may be wedged)`,
      );
    }
  }, MONGO_WATCHDOG_INTERVAL_MS).unref();

  await client.connect();
  db = client.db();
  console.log("[db] connected to MongoDB");
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}
