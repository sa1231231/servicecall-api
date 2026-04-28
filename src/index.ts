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
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,                  // 10 attempts per minute per IP
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

// ── Basic Auth for form + dashboard ─────────────────────────────────────────
import type { Request, Response, NextFunction } from "express";

async function basicAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
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

  // Try DB user first
  const dbUser = await getUser(username);
  if (dbUser && verifyPassword(pass, dbUser.password_hash)) {
    req.user = {
      username,
      role: dbUser.role,
      permissions: resolvePermissions(dbUser.role, dbUser.permissions),
      isOwner: false,
    };
    next();
    return;
  }

  // Fallback: legacy ADMIN_PASSWORD (always grants admin — this is the owner)
  if (pass === config.ADMIN_PASSWORD) {
    req.user = {
      username: username || "admin",
      role: "admin",
      permissions: { ...DEFAULT_PERMISSIONS.admin },
      isOwner: true,
    };
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
formRouter.get("/config", (_req, res) => {
  res.json({ apiKey: config.API_KEY });
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

app.use("/form", authLimiter, basicAuth, requirePermission("create_agents"), formRouter);

// ── Dashboard (Basic Auth protected) ────────────────────────────────────────
app.use("/dashboard", authLimiter, basicAuth, dashboardRouter);

// ── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const key = req.headers["x-api-key"];
  if (key !== config.API_KEY) {
    console.log(`[auth] rejected request to ${req.originalUrl}`);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// ── Authenticated routes ─────────────────────────────────────────────────────
// app.use("/stripe", stripeRouter);
app.use("/deckscience", deckscienceRouter);
app.use("/agents", agentsRouter);
app.use("/qa", qaRouter);
app.use("/dashboard/api", authLimiter, basicAuth, dashboardApiRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/backup", authLimiter, basicAuth, requirePermission("manage_settings"), backupRouter);

// ── Start ────────────────────────────────────────────────────────────────────
await initDb();
await ensureAuditIndex();
await purgeExpiredClients();
await loadClientsFromDb();
await refreshOwnerConfig();

app.listen(Number(config.PORT), () => {
  console.log(`ServiceCall API listening on port ${config.PORT}`);
  startAutoSync();
  startWeeklyReportScheduler();

  // Daily backup at 3:00 AM UTC
  if (isR2Configured()) {
    const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const now = new Date();
    const next3am = new Date(now);
    next3am.setUTCHours(7, 0, 0, 0); // 3:00 AM ET = 7:00 AM UTC (EDT) / 8:00 AM UTC (EST)
    if (next3am <= now) next3am.setUTCDate(next3am.getUTCDate() + 1);
    const msUntilFirst = next3am.getTime() - now.getTime();

    console.log(`[backup] scheduled daily at 03:00 ET (first in ${Math.round(msUntilFirst / 60000)} min)`);
    setTimeout(() => {
      runBackup().catch(() => {});
      setInterval(() => runBackup().catch(() => {}), BACKUP_INTERVAL_MS);
    }, msUntilFirst);
  } else {
    console.log("[backup] skipped — R2 env vars not configured");
  }
});
