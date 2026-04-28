import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import express from "express";
import { config } from "../../config.js";
import { listAgentsHandler } from "./list-agents.js";
import { toggleShadowHandler } from "./toggle-shadow.js";
import { getAgentHandler } from "./get-agent.js";
import { getCallsHandler } from "./get-calls.js";
import { updateAgentHandler } from "./update-agent.js";
import { cloneAgentHandler } from "./clone-agent.js";
import { deleteAgentHandler } from "./delete-agent.js";
import {
  getClientDocument,
  generatePortalToken,
} from "../../config/client-store.js";
import { getCallLogById } from "../../lib/call-log.js";
import { sendSmsToAll } from "../../lib/notify-sms.js";
import { getSettings, updateSettings } from "../../lib/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardHtmlPath = path.join(__dirname, "../../../public/dashboard.html");

// Public routes (no auth): serves HTML and config
export const dashboardRouter = Router();

dashboardRouter.get("/", (_req, res) => {
  try {
    res.type("html").send(fs.readFileSync(dashboardHtmlPath, "utf8"));
  } catch (err) {
    console.error("[dashboard] failed to read dashboard.html:", dashboardHtmlPath, err);
    res.status(500).send("Dashboard not found");
  }
});

dashboardRouter.get("/config", (_req, res) => {
  res.json({ apiKey: config.API_KEY });
});

// Authenticated API routes
export const dashboardApiRouter = Router();
dashboardApiRouter.use(express.json());

dashboardApiRouter.get("/agents", listAgentsHandler);
dashboardApiRouter.get("/agents/:slug", getAgentHandler);
dashboardApiRouter.get("/agents/:slug/calls", getCallsHandler);
dashboardApiRouter.patch("/agents/:slug/shadow", toggleShadowHandler);
dashboardApiRouter.patch("/agents/:slug", updateAgentHandler);
dashboardApiRouter.post("/agents/:slug/clone", cloneAgentHandler);
dashboardApiRouter.delete("/agents/:slug", deleteAgentHandler);

dashboardApiRouter.get("/agents/:slug/calls/:callId/transcript", async (req, res) => {
  const { slug, callId } = req.params;
  const callLog = await getCallLogById(callId);
  if (!callLog || callLog.client_slug !== slug) {
    res.status(404).json({ error: "Call not found" });
    return;
  }
  if (!callLog.transcript) {
    res.status(404).json({ error: "Transcript not available yet" });
    return;
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="transcript-${callId}.txt"`);
  res.send(callLog.transcript);
});

dashboardApiRouter.get("/agents/:slug/portal-token", async (req, res) => {
  const slug = String(req.params.slug);
  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }
  const hasToken = !!doc.portal_token;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const portalUrl = hasToken
    ? `${baseUrl}/portal/${slug}?token=${doc.portal_token}`
    : null;
  res.json({ has_token: hasToken, portal_url: portalUrl });
});

dashboardApiRouter.post("/agents/:slug/portal-token", async (req, res) => {
  const slug = String(req.params.slug);
  try {
    const doc = await getClientDocument(slug);
    if (!doc) {
      res.status(404).json({ error: `Client "${slug}" not found` });
      return;
    }
    const token = await generatePortalToken(slug);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const portalUrl = `${baseUrl}/portal/${slug}?token=${token}`;
    res.json({ success: true, portal_url: portalUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

dashboardApiRouter.post("/agents/:slug/request-review", async (req, res) => {
  const slug = String(req.params.slug);
  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  const settings = await getSettings();
  if (!settings.google_review_url) {
    res.status(400).json({ error: "Google Review URL is not configured. Set it in Settings." });
    return;
  }

  const numbers = doc.dispatch_text_numbers ?? [];
  if (numbers.length === 0) {
    res.status(400).json({ error: "No dispatch text numbers configured for this client" });
    return;
  }

  const message = settings.review_sms_message.replace(
    /\{\{google_review_url\}\}/g,
    settings.google_review_url,
  );

  try {
    await sendSmsToAll(numbers, message);
    res.json({ success: true, sent_to: numbers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to send review request", details: msg });
  }
});

dashboardApiRouter.post("/agents/:slug/send-payment-link", async (req, res) => {
  const slug = String(req.params.slug);
  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  const settings = await getSettings();
  if (!settings.stripe_payment_url) {
    res.status(400).json({ error: "Stripe Payment URL is not configured. Set it in Settings." });
    return;
  }

  const numbers = doc.dispatch_text_numbers ?? [];
  if (numbers.length === 0) {
    res.status(400).json({ error: "No dispatch text numbers configured for this client" });
    return;
  }

  const message = settings.payment_sms_message.replace(
    /\{\{stripe_payment_url\}\}/g,
    settings.stripe_payment_url,
  );

  try {
    await sendSmsToAll(numbers, message);
    res.json({ success: true, sent_to: numbers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to send payment link", details: msg });
  }
});

// ── Global Settings ─────────────────────────────────────────────────────────

dashboardApiRouter.get("/settings", async (_req, res) => {
  res.json(await getSettings());
});

dashboardApiRouter.patch("/settings", async (req, res) => {
  try {
    const updated = await updateSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});
