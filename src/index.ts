import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { initDb } from "./lib/db.js";
import { loadClientsFromDb, purgeExpiredClients } from "./config/client-store.js";
import { healthRouter } from "./routes/health.js";
import { stripeRouter } from "./routes/stripe/index.js";
import { retellRouter } from "./routes/retell/index.js";
import { deckscienceRouter } from "./routes/deckscience/index.js";
import { agentsRouter } from "./routes/agents/index.js";
import { dashboardRouter, dashboardApiRouter, backupRouter } from "./routes/dashboard/index.js";
import { qaRouter } from "./routes/qa.js";
import { portalRouter } from "./routes/portal/index.js";
import { startAutoSync } from "./lib/retell-auto-sync.js";
import { startWeeklyReportScheduler } from "./lib/weekly-report.js";
import { reportsRouter } from "./routes/reports/index.js";
import { refreshOwnerConfig } from "./lib/settings.js";
import { getDataPointDefaultsWithCategory, CATEGORY_ORDER, CATEGORY_LABELS } from "./lib/data-point-defaults.js";
import { ObjectId } from "mongodb";
import { getDb } from "./lib/db.js";
import { runBackup, isR2Configured } from "./lib/backup.js";
import { getUser, verifyPassword, resolvePermissions, DEFAULT_PERMISSIONS } from "./lib/users.js";
import { ensureAuditIndex } from "./lib/audit.js";
import { ensureVersionIndexes } from "./lib/agent-versions.js";
import { requirePermission } from "./middleware/require-role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Tighter limiter for login-protected routes — prevent brute-force
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30,                  // 30 attempts per 5 minutes per IP
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

const app = express();
app.set("trust proxy", 1);
app.use(globalLimiter);

app.use((req, res, next) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    headers: {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
    },
    query: Object.keys(req.query).length ? req.query : undefined,
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
app.use("/portal", portalLimiter, portalRouter);

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
const COOKIE_SECRET = config.ROOT_PASSWORD; // Use root password as HMAC key

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

  let user: NonNullable<Request["user"]> | null = null;

  // Try DB user first
  const dbUser = await getUser(username);
  if (dbUser && verifyPassword(pass, dbUser.password_hash)) {
    user = {
      username,
      role: dbUser.role,
      permissions: resolvePermissions(dbUser.role, dbUser.permissions),
      isRoot: false,
    };
  }

  // Fallback: ROOT_PASSWORD (always grants admin — this is root)
  if (!user && pass === config.ROOT_PASSWORD) {
    user = {
      username: username || "admin",
      role: "admin",
      permissions: { ...DEFAULT_PERMISSIONS.admin },
      isRoot: true,
    };
  }

  if (user) {
    setSessionCookie(res, user);
    req.user = user;
    next();
    return;
  }

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

// ── Agent Drafts & Templates ────────────────────────────────────────────────
function draftsCollection() {
  return getDb().collection("agent_drafts");
}

formRouter.get("/drafts", async (req, res) => {
  try {
    const filter: any = {};
    if (req.query.type === "template") {
      filter.type = "template";
    } else if (req.query.type === "draft" || !req.query.type) {
      // Default: return drafts (including legacy docs without a type field)
      filter.type = { $ne: "template" };
    }
    const drafts = await draftsCollection()
      .find(filter, { projection: { name: 1, type: 1, updatedAt: 1 } })
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
    const { name, formData, type } = req.body;
    if (!name || !formData) { res.status(400).json({ error: "name and formData are required" }); return; }
    const result = await draftsCollection().insertOne({
      name,
      formData,
      type: type === "template" ? "template" : "draft",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res.json({ success: true, _id: result.insertedId, name });
  } catch (err) {
    res.status(500).json({ error: "Failed to save draft" });
  }
});

formRouter.put("/drafts/:id", async (req, res) => {
  try {
    const { name, formData } = req.body;
    const updates: any = { updatedAt: new Date() };
    if (name) updates.name = name;
    if (formData) updates.formData = formData;
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

app.use("/form", authLimiter, sessionAuth, requirePermission("create_agents"), formRouter);

// ── Dashboard (Basic Auth protected) ────────────────────────────────────────
app.use("/dashboard", sessionAuth);
app.use("/dashboard", dashboardRouter);
app.use("/dashboard/api", dashboardApiRouter);
app.use("/api/backup", sessionAuth, requirePermission("manage_settings"), backupRouter);
app.use("/qa", sessionAuth, qaRouter);
app.use("/api/reports", sessionAuth, reportsRouter);

// ── API Key middleware (external/machine routes only) ────────────────────────
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== config.API_KEY) {
    console.log(`[auth] rejected request to ${req.originalUrl}`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// ── External/machine routes (API key protected) ──────────────────────────────
// app.use("/stripe", stripeRouter);
app.use("/deckscience", deckscienceRouter);
app.use("/agents", agentsRouter);

// ── Start ────────────────────────────────────────────────────────────────────
await initDb();
await ensureAuditIndex();
await ensureVersionIndexes();
await purgeExpiredClients();
await loadClientsFromDb();
await refreshOwnerConfig();

app.listen(Number(config.PORT), () => {
  console.log(`ServiceCall API listening on port ${config.PORT}`);
  startAutoSync();
  startWeeklyReportScheduler();

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
