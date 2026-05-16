import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { initDb } from "./lib/db.js";
import { loadClientsFromDb, purgeExpiredClients } from "./config/client-store.js";
import { healthRouter } from "./routes/health.js";
import { retellRouter } from "./routes/retell/index.js";
import { mcpRouter, mcpEdgeCapture } from "./routes/mcp.js";
import { deckscienceRouter } from "./routes/deckscience/index.js";
import { agentsRouter } from "./routes/agents/index.js";
import { dashboardRouter, dashboardApiRouter, backupRouter } from "./routes/dashboard/index.js";
import { suggestionsRouter } from "./routes/dashboard/suggestions.js";
import { qaRouter } from "./routes/qa.js";
import { leadsRouter, leadsIntakeRouter } from "./routes/leads/index.js";
import { portalRouter } from "./routes/portal/index.js";
import { startAutoSync } from "./lib/retell-auto-sync.js";
import { startWeeklyReportScheduler } from "./lib/weekly-report.js";
import { reportsRouter } from "./routes/reports/index.js";
import { refreshOwnerConfig } from "./lib/settings.js";
import { loadRoleDefaultsCache } from "./lib/role-defaults.js";
import { getDataPointDefaultsWithCategory, CATEGORY_ORDER, CATEGORY_LABELS } from "./lib/data-point-defaults.js";
import { ObjectId } from "mongodb";
import { getDb } from "./lib/db.js";
import { runBackup, isR2Configured } from "./lib/backup.js";
import { getUser, verifyPassword, resolvePermissions, resolveUserFeaturePermissions, DEFAULT_PERMISSIONS } from "./lib/users.js";
import { SEED_FEATURE_DEFAULTS } from "./lib/feature-permissions.js";
import { ensureAuditIndex } from "./lib/audit.js";
import { ensureVersionIndexes } from "./lib/agent-versions.js";
import { ensurePendingLeadIndexes, resetStaleEnrichingLeads } from "./lib/pending-leads.js";
import { ensureCallFindingIndexes } from "./lib/call-findings.js";
import { ensureSuggestionIndexes } from "./lib/improvement-suggestions.js";
import { ensureCallLogIndexes } from "./lib/call-log.js";
import { requireFeature } from "./middleware/require-role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50000,               // ~3333/min — the system test suite fires
                            // hundreds of requests per run and is run
                            // repeatedly back-to-back during dev; a
                            // 5000/15min ceiling drained partway through
                            // a session and 429-stormed every subsequent
                            // run. This headroom lets the suite run
                            // freely. Real-world dashboard traffic stays
                            // orders of magnitude below this; it remains
                            // a coarse flood guard, and brute-force
                            // protection still applies via per-username
                            // lockout + the tighter authLimiter below.
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Tighter limiter for login-protected routes — prevent brute-force.
// Applied to /form, which sees normal-user save/autosave traffic, so we
// allow ~24/min: still firm against credential-stuffing but won't punish
// a user editing the agent form for an extended session.
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 120,                 // 120 attempts per 5 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts, please try again later.",
});

// Lenient limiter for Retell webhooks — they may burst multiple calls
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Dedicated limiter for the MCP server. /mcp must NOT share the 60/min
// webhookLimiter bucket: Retell's MCP client makes several requests per
// voice call (handshake + tool calls), and a 429 there is rejected before
// the router even sees it — surfacing to Retell as an opaque
// "error parsing json response from mcp server". /mcp is API-key
// authenticated, so a generous ceiling is safe; this stays a flood guard.
const mcpLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const app = express();
app.set("trust proxy", 1);
app.use(globalLimiter);

// Query-string keys that may carry secrets (portal magic links use
// ?token=...). The request logger redacts them before printing so
// Railway's log retention never holds a usable credential.
const REDACT_QUERY_KEYS = new Set(["token", "api_key", "key", "password", "secret"]);

function redactQuery(q: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    out[k] = REDACT_QUERY_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}

app.use((req, res, next) => {
  const start = Date.now();
  // We deliberately allowlist headers (only content-type + user-agent
  // make it into logs). Authorization, Cookie, x-api-key, and webhook
  // signatures stay out by construction. If a future edit broadens this
  // object, audit it carefully — the allowlist is the security boundary.
  console.log(`--> ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
    },
    query: Object.keys(req.query).length ? redactQuery(req.query as Record<string, unknown>) : undefined,
  });

  res.on("finish", () => {
    console.log(
      `<-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`,
    );
  });

  next();
});

// Portal rate limiter — tighter to prevent token brute-force
const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

app.use("/health", healthRouter);
app.use("/retell", webhookLimiter, retellRouter);

// MCP (Model Context Protocol) server — JSON-RPC over HTTP. Currently
// surfaces send_sms for mid-call Retell conversation-flow McpNode
// invocations; designed to grow as we add more tools. Bearer-token auth.
// Uses its own generous limiter — see mcpLimiter above. mcpEdgeCapture runs
// first (before the limiter) — TEMP diagnostic, records every hit + status.
app.use("/mcp", mcpEdgeCapture, mcpLimiter, mcpRouter);
app.use("/portal", portalLimiter, portalRouter);

// ── Public static assets (CSS, JS, images) ──────────────────────────────────
// Only the /assets prefix is exposed — HTML files under /public stay
// auth-gated through their named routes. Cache for a year since the path
// versions naturally on file rename; long-lived clients pick up changes via
// a new commit's new path.
app.use(
  "/assets",
  express.static(path.join(__dirname, "..", "public", "assets"), {
    maxAge: "1y",
    immutable: false,
    fallthrough: false,
  }),
);

// ── Client login (public, no auth) ──────────────────────────────────────────
const clientLoginHtmlPath = path.join(__dirname, "..", "public", "client-login.html");
app.get("/client", (_req, res) => {
  try {
    res.type("html").send(fs.readFileSync(clientLoginHtmlPath, "utf8"));
  } catch (err) {
    console.error("[client] failed to read client-login.html:", err);
    res.status(500).send("Page not found");
  }
});

// ── Session auth (cookie-based) for form + dashboard ────────────────────────
import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const SESSION_COOKIE = "scs_session";
const SESSION_MAX_AGE = 14 * 24 * 60 * 60; // 14 days in seconds
// Cookie HMAC key — SESSION_SECRET, NOT ROOT_PASSWORD. A leaked
// break-glass password should not let an attacker forge sessions for
// arbitrary users; the two secrets rotate independently.
const COOKIE_SECRET = config.SESSION_SECRET;

// ── Login lockout (in-memory) ────────────────────────────────────────────
// 5 failed logins within LOCKOUT_WINDOW_MS triggers a LOCKOUT_DURATION_MS
// freeze on that username. State is per-process — a redeploy clears it.
// Per-username (not per-IP) so an attacker can't DoS a real user by
// hammering from many IPs; a real user behind the same NAT also won't
// trip on someone else's typo bursts.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
type LockoutState = { failures: number[]; lockedUntil: number };
const lockoutMap = new Map<string, LockoutState>();

function checkLockout(username: string): { locked: boolean; retryAfterSec?: number } {
  const s = lockoutMap.get(username);
  if (!s) return { locked: false };
  const now = Date.now();
  if (s.lockedUntil > now) return { locked: true, retryAfterSec: Math.ceil((s.lockedUntil - now) / 1000) };
  return { locked: false };
}

function recordLoginFailure(username: string): void {
  const now = Date.now();
  const s = lockoutMap.get(username) ?? { failures: [], lockedUntil: 0 };
  s.failures = s.failures.filter((t) => now - t < LOCKOUT_WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= LOCKOUT_THRESHOLD) {
    s.lockedUntil = now + LOCKOUT_DURATION_MS;
    s.failures = [];
    console.warn(`[auth] locked out ${username} for ${LOCKOUT_DURATION_MS / 60000} minutes after ${LOCKOUT_THRESHOLD} failures`);
  }
  lockoutMap.set(username, s);
}

function recordLoginSuccess(username: string): void {
  lockoutMap.delete(username);
}

function signSession(payload: object): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64url");
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(b64).digest("base64url");
  return b64 + "." + sig;
}

function verifySession(cookie: string): NonNullable<Request["user"]> | null {
  const dot = cookie.indexOf(".");
  if (dot < 0) return null;
  const b64 = cookie.substring(0, dot);
  const sig = cookie.substring(dot + 1);
  const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(b64).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64url").toString());
  } catch {
    return null;
  }
}

function setSessionCookie(res: Response, user: NonNullable<Request["user"]>): void {
  const value = signSession(user);
  res.cookie(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE * 1000,
    path: "/",
  });
}

/** Authenticate via session cookie or Basic Auth. Sets cookie on successful Basic Auth. */
async function sessionAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Check session cookie first
  const raw = req.headers.cookie ?? "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (match) {
    const user = verifySession(match[1]);
    if (user) {
      // Refresh permissions from DB to handle stale cookies
      if (user.isRoot) {
        user.permissions = { ...DEFAULT_PERMISSIONS.super_admin };
        user.featurePermissions = { ...SEED_FEATURE_DEFAULTS.super_admin };
      } else {
        const dbUser = await getUser(user.username);
        if (dbUser) {
          user.role = dbUser.role;
          user.permissions = resolvePermissions(dbUser.role, dbUser.permissions);
          user.featurePermissions = resolveUserFeaturePermissions(dbUser);
        }
      }
      req.user = user;
      next();
      return;
    }
  }

  // 2. Fall back to Basic Auth (initial login)
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="ServiceCall Saver"');
    res.status(401).send("Authentication required");
    return;
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString();
  const colon = decoded.indexOf(":");
  const username = decoded.substring(0, colon).toLowerCase();
  const pass = decoded.substring(colon + 1);

  // Reject locked-out usernames before checking the password so an
  // attacker can't keep verifying password guesses past the threshold.
  const lock = checkLockout(username);
  if (lock.locked) {
    res.set("Retry-After", String(lock.retryAfterSec ?? 60));
    res.status(429).send("Account temporarily locked. Try again later.");
    return;
  }

  let user: NonNullable<Request["user"]> | null = null;

  // Try DB user first
  const dbUser = await getUser(username);
  if (dbUser && verifyPassword(pass, dbUser.password_hash)) {
    user = {
      username,
      role: dbUser.role,
      permissions: resolvePermissions(dbUser.role, dbUser.permissions),
      featurePermissions: resolveUserFeaturePermissions(dbUser),
      isRoot: false,
    };
  }

  // Fallback: ROOT_PASSWORD (always grants admin — this is root). Compare
  // constant-time so the response time doesn't reveal how many leading
  // characters of the break-glass password a guess matched.
  if (!user) {
    const rootPw = config.ROOT_PASSWORD;
    const provided = Buffer.from(pass);
    const expected = Buffer.from(rootPw);
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      user = {
        username: username || "admin",
        role: "admin",
        permissions: { ...DEFAULT_PERMISSIONS.super_admin },
        featurePermissions: { ...SEED_FEATURE_DEFAULTS.super_admin },
        isRoot: true,
      };
    }
  }

  if (user) {
    recordLoginSuccess(username);
    setSessionCookie(res, user);
    req.user = user;
    next();
    return;
  }

  recordLoginFailure(username);
  res.set("WWW-Authenticate", 'Basic realm="ServiceCall Saver"');
  res.status(401).send("Invalid credentials");
}


// ── Form (Basic Auth protected) ─────────────────────────────────────────────
const formRouter = express.Router();
formRouter.use(express.json());
const formHtmlPath = path.join(__dirname, "..", "public", "index.html");
formRouter.get("/", (_req, res) => {
  try {
    res.type("html").send(fs.readFileSync(formHtmlPath, "utf8"));
  } catch (err) {
    console.error("[form] failed to read index.html:", formHtmlPath, err);
    res.status(500).send("Form not found");
  }
});
formRouter.get("/config", async (_req, res) => {
  const { getSettings } = await import("./lib/settings.js");
  const settings = await getSettings();
  res.json({
    apiKey: config.API_KEY,
    default_summary_agent_id: settings.default_summary_agent_id || "",
    owner_phone: settings.owner_phone || "",
  });
});
formRouter.get("/data-points", async (_req, res) => {
  try {
    const all = await getDataPointDefaultsWithCategory();
    res.json({ dataPoints: all, categoryOrder: CATEGORY_ORDER, categoryLabels: CATEGORY_LABELS });
  } catch (err) {
    res.status(500).json({ error: "Failed to load data points" });
  }
});

// ── Agent Drafts ────────────────────────────────────────────────────────────
// Drafts and "templates" used to be tracked separately via a `type` field on
// each doc; that distinction is gone. Every saved form config is just a draft.
// A user can name a draft "Template - Foo" by convention if they want, but
// the code makes no distinction.
function draftsCollection() {
  return getDb().collection("agent_drafts");
}

formRouter.get("/drafts", async (_req, res) => {
  try {
    const drafts = await draftsCollection()
      .find({}, { projection: { name: 1, updatedAt: 1 } })
      .sort({ updatedAt: -1 })
      .toArray();
    res.json(drafts);
  } catch (err) {
    res.status(500).json({ error: "Failed to load drafts" });
  }
});

formRouter.get("/drafts/:id", async (req, res) => {
  try {
    const draft = await draftsCollection().findOne({ _id: new ObjectId(req.params.id) });
    if (!draft) { res.status(404).json({ error: "Draft not found" }); return; }
    res.json(draft);
  } catch (err) {
    res.status(500).json({ error: "Failed to load draft" });
  }
});

formRouter.post("/drafts", async (req, res) => {
  try {
    const { name, formData, exportConfig } = req.body;
    if (!name || !formData) { res.status(400).json({ error: "name and formData are required" }); return; }
    const doc: Record<string, unknown> = {
      name,
      formData,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (exportConfig) doc.exportConfig = exportConfig;
    const result = await draftsCollection().insertOne(doc);
    res.json({ success: true, _id: result.insertedId, name });
  } catch (err) {
    res.status(500).json({ error: "Failed to save draft" });
  }
});

formRouter.put("/drafts/:id", async (req, res) => {
  try {
    const { name, formData, exportConfig } = req.body;
    const updates: any = { updatedAt: new Date() };
    if (name) updates.name = name;
    if (formData) updates.formData = formData;
    if (exportConfig) updates.exportConfig = exportConfig;
    const result = await draftsCollection().findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updates },
      { returnDocument: "after" },
    );
    if (!result) { res.status(404).json({ error: "Draft not found" }); return; }
    res.json({ success: true, draft: result });
  } catch (err) {
    res.status(500).json({ error: "Failed to update draft" });
  }
});

formRouter.delete("/drafts/:id", async (req, res) => {
  try {
    const result = await draftsCollection().deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) { res.status(404).json({ error: "Draft not found" }); return; }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete draft" });
  }
});

app.use("/form", authLimiter, sessionAuth, requireFeature("agent_lifecycle", "write"), formRouter);

// ── Quick Create (one-page agent-from-draft instantiator) ───────────────────
const quickCreateHtmlPath = path.join(__dirname, "..", "public", "quick-create.html");
app.get(
  "/quick-create",
  authLimiter,
  sessionAuth,
  requireFeature("agent_lifecycle", "write"),
  (_req, res) => {
    try {
      res.type("html").send(fs.readFileSync(quickCreateHtmlPath, "utf8"));
    } catch (err) {
      console.error("[quick-create] failed to read quick-create.html:", err);
      res.status(500).send("Page not found");
    }
  },
);

// ── Logout (no auth required so a stale/invalid cookie can still be cleared) ─
// Mounted BEFORE sessionAuth so the user can always reach it, even if their
// session is no longer valid (e.g., after SESSION_SECRET rotation).
app.post("/dashboard/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ success: true });
});

// ── Dashboard (Basic Auth protected) ────────────────────────────────────────
app.use("/dashboard", sessionAuth);
app.use("/dashboard", dashboardRouter);
app.use("/dashboard/api", dashboardApiRouter);
app.use("/dashboard/api", suggestionsRouter);
app.use("/api/backup", sessionAuth, requireFeature("backups", "write"), backupRouter);
app.use("/qa", sessionAuth, qaRouter);
// Intake mounts BEFORE the session-protected leadsRouter so its bearer-token
// auth wins over sessionAuth on the more specific path.
app.use("/api/leads/intake", leadsIntakeRouter);
app.use("/api/leads", sessionAuth, leadsRouter);
app.use("/api/reports", sessionAuth, reportsRouter);

// ── API Key middleware (external/machine routes only) ────────────────────────
app.use((req, res, next) => {
  const provided = req.headers["x-api-key"];
  // Constant-time compare so a remote attacker can't infer leading
  // characters of API_KEY from response timing. Length must match
  // before timingSafeEqual or it throws.
  const expected = config.API_KEY;
  let ok = false;
  if (typeof provided === "string" && provided.length === expected.length) {
    ok = crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }
  if (!ok) {
    console.log(`[auth] rejected request to ${req.originalUrl}`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// ── External/machine routes (API key protected) ──────────────────────────────
app.use("/deckscience", deckscienceRouter);
app.use("/agents", agentsRouter);

// ── Start ────────────────────────────────────────────────────────────────────
await initDb();
await ensureAuditIndex();
await ensureVersionIndexes();
await ensurePendingLeadIndexes();
await ensureCallFindingIndexes();
await ensureSuggestionIndexes();
await ensureCallLogIndexes();
await resetStaleEnrichingLeads();
await purgeExpiredClients();
await loadClientsFromDb();
await refreshOwnerConfig();
await loadRoleDefaultsCache();

app.listen(Number(config.PORT), () => {
  console.log(`ServiceCall API listening on port ${config.PORT}`);
  startAutoSync();
  startWeeklyReportScheduler();

  // One-time: promote sam_admin to super_admin
  (async () => {
    try {
      const result = await getDb().collection("users").updateOne(
        { _id: "sam_admin" as any, role: { $ne: "super_admin" } },
        { $set: { role: "super_admin", permissions: {
          create_agents: true, edit_agents: true, clone_agents: true,
          delete_agents: true, send_comms: true, manage_settings: true,
          manage_data_points: true, manage_users: true,
          view_billing: true, manage_deleted: true,
        } } },
      );
      if (result.modifiedCount > 0) console.log("[users] promoted sam_admin to super_admin");
    } catch (err) { console.warn("[users] sam_admin promotion failed:", err); }
  })();

  // One-time: ensure all Retell phone numbers have pre-hook webhook
  (async () => {
    try {
      const Retell = (await import("retell-sdk")).default;
      const retell = new Retell({ apiKey: config.RETELL_API_KEY });
      const preHookUrl = "https://servicecall-api-production.up.railway.app/retell/pre-hook";
      const phones = await retell.phoneNumber.list();
      let updated = 0;
      for (const phone of phones) {
        if (!phone.inbound_webhook_url || phone.inbound_webhook_url !== preHookUrl) {
          try {
            await retell.phoneNumber.update(phone.phone_number, { inbound_webhook_url: preHookUrl });
            updated++;
          } catch (err) {
            console.warn(`[pre-hook] failed to update ${phone.phone_number}:`, err);
          }
        }
      }
      console.log(`[pre-hook] checked ${phones.length} phone numbers, updated ${updated}`);
    } catch (err) {
      console.error("[pre-hook] migration failed:", err);
    }
  })();

  // Hourly backup to R2
  if (isR2Configured()) {
    const BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setUTCMinutes(0, 0, 0);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    const msUntilFirst = nextHour.getTime() - now.getTime();

    console.log(`[backup] scheduled hourly (first in ${Math.round(msUntilFirst / 60000)} min)`);
    setTimeout(() => {
      runBackup().catch(() => {});
      setInterval(() => runBackup().catch(() => {}), BACKUP_INTERVAL_MS);
    }, msUntilFirst);
  } else {
    console.log("[backup] skipped — R2 env vars not configured");
  }
});
