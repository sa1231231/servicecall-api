import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import express from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { listAgentsHandler } from "./list-agents.js";
import { toggleShadowHandler } from "./toggle-shadow.js";
import { toggleActiveHandler } from "./toggle-active.js";
import { getAgentHandler } from "./get-agent.js";
import { getCallsHandler } from "./get-calls.js";
import { updateAgentHandler } from "./update-agent.js";
import { cloneAgentHandler } from "./clone-agent.js";
import { deleteAgentHandler } from "./delete-agent.js";
import {
  getClientDocument,
  generatePortalToken,
  listDeletedClients,
  restoreClient,
  deleteClient,
} from "../../config/client-store.js";
import { getCallLogById } from "../../lib/call-log.js";
import { sendSmsToAll } from "../../lib/notify-sms.js";
import { getSettings, updateSettings } from "../../lib/settings.js";
import { runBackup } from "../../lib/backup.js";
import {
  getDataPointDefaultsWithCategory,
  updateDataPointDefault,
  createDataPointDefault,
  deleteDataPointDefault,
  reorderDataPointDefaults,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
} from "../../lib/data-point-defaults.js";
import { requirePermission, requireRoot } from "../../middleware/require-role.js";
import { logAudit } from "../../lib/audit.js";
import { nodeEditorRouter } from "./node-editor.js";
import { alertRootIfNeeded } from "../../lib/root-alerts.js";
import {
  listUsers,
  createUser,
  deleteUser,
  updateUserPermissions,
  PERMISSION_DEFS,
  DEFAULT_PERMISSIONS,
} from "../../lib/users.js";

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

dashboardRouter.get("/config", (req, res) => {
  res.json({
    apiKey: config.API_KEY,
    user: req.user
      ? { username: req.user.username, role: req.user.role, permissions: req.user.permissions, isRoot: req.user.isRoot }
      : null,
    permissionDefs: PERMISSION_DEFS,
    defaultPermissions: DEFAULT_PERMISSIONS,
  });
});

// Authenticated API routes
export const dashboardApiRouter = Router();
dashboardApiRouter.use(express.json());

dashboardApiRouter.get("/agents", listAgentsHandler);
dashboardApiRouter.get("/agents/:slug", getAgentHandler);
dashboardApiRouter.get("/agents/:slug/calls", getCallsHandler);
dashboardApiRouter.patch("/agents/:slug/shadow", requirePermission("edit_agents"), toggleShadowHandler);
dashboardApiRouter.patch("/agents/:slug/active", requirePermission("edit_agents"), toggleActiveHandler);
dashboardApiRouter.patch("/agents/:slug", requirePermission("edit_agents"), updateAgentHandler);
dashboardApiRouter.post("/agents/:slug/clone", requirePermission("clone_agents"), cloneAgentHandler);
dashboardApiRouter.delete("/agents/:slug", requirePermission("delete_agents"), deleteAgentHandler);

// ── Export ───────────────────────────────────────────────────────────────────
import { exportAgentHandler } from "../agents/export-agent.js";
dashboardApiRouter.get("/agents/:slug/export", exportAgentHandler);

// ── Node Editor ──────────────────────────────────────────────────────────────
dashboardApiRouter.use("/agents/:slug/nodes", requirePermission("edit_agents"), nodeEditorRouter);

// ── Soft-Deleted Agents (Recovery) ──────────────────────────────────────────

dashboardApiRouter.get("/deleted-agents", requirePermission("manage_deleted"), async (_req, res) => {
  const deleted = await listDeletedClients();
  res.json(deleted);
});

dashboardApiRouter.post("/deleted-agents/:slug/restore", requirePermission("manage_deleted"), async (req, res) => {
  const slug = String(req.params.slug);
  try {
    // Restore the Retell agent names (strip "[DELETED — expires ...]" suffix)
    const doc = await getClientDocument(slug);
    if (doc) {
      const retell = new Retell({ apiKey: config.RETELL_API_KEY });
      const deletedPattern = /\s*\[DELETED — expires \d{4}-\d{2}-\d{2}\]$/;
      const allIds = new Set([
        ...Object.keys(doc.retell_agents ?? {}),
        ...(doc.agent_ids ?? []),
      ]);
      for (const agentId of allIds) {
        try {
          const agent = await retell.agent.retrieve(agentId);
          const cleaned = (agent.agent_name ?? "").replace(deletedPattern, "");
          if (cleaned !== agent.agent_name) {
            await retell.agent.update(agentId, { agent_name: cleaned });
            console.log(`[restore-agent] renamed Retell agent ${agentId} back to "${cleaned}"`);
          }
        } catch (err) {
          console.warn(`[restore-agent] could not rename Retell agent ${agentId}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    await restoreClient(slug);
    await logAudit(req, "restore_agent", slug);
    alertRootIfNeeded(req, "restore_agent", slug);
    res.json({ success: true, slug });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

dashboardApiRouter.delete("/deleted-agents/:slug", requirePermission("manage_deleted"), async (req, res) => {
  const slug = String(req.params.slug);
  try {
    // Actually delete from Retell now (permanent delete)
    const doc = await getClientDocument(slug);
    if (doc) {
      const retell = new Retell({ apiKey: config.RETELL_API_KEY });
      const retellAgents = doc.retell_agents ?? {};
      for (const [agentId, agentJson] of Object.entries(retellAgents)) {
        try {
          await retell.agent.delete(agentId);
          console.log(`[permanent-delete] deleted Retell agent ${agentId}`);
        } catch (err) {
          console.warn(`[permanent-delete] could not delete Retell agent ${agentId}: ${err instanceof Error ? err.message : err}`);
        }
        const flowId =
          (agentJson as Record<string, any>)?.conversationFlow?.conversation_flow_id ??
          (agentJson as Record<string, any>)?.response_engine?.conversation_flow_id;
        if (flowId) {
          try {
            await retell.conversationFlow.delete(flowId);
            console.log(`[permanent-delete] deleted Retell flow ${flowId}`);
          } catch (err) {
            console.warn(`[permanent-delete] could not delete Retell flow ${flowId}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      for (const agentId of doc.agent_ids ?? []) {
        if (retellAgents[agentId]) continue;
        try {
          await retell.agent.delete(agentId);
          console.log(`[permanent-delete] deleted Retell agent ${agentId} (from agent_ids)`);
        } catch (err) {
          console.warn(`[permanent-delete] could not delete Retell agent ${agentId}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    await deleteClient(slug);
    await logAudit(req, "permanent_delete_agent", slug);
    alertRootIfNeeded(req, "permanent_delete_agent", slug);
    res.json({ success: true, slug });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

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

dashboardApiRouter.post("/agents/:slug/request-review", requirePermission("send_comms"), async (req, res) => {
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

dashboardApiRouter.post("/agents/:slug/send-payment-link", requirePermission("send_comms"), async (req, res) => {
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

dashboardApiRouter.post("/agents/:slug/send-portal-link", requirePermission("send_comms"), async (req, res) => {
  const slug = String(req.params.slug);
  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  if (!doc.portal_token) {
    res.status(400).json({ error: "Portal link has not been generated yet. Generate it first from the agent detail page." });
    return;
  }

  const numbers = doc.dispatch_text_numbers ?? [];
  if (numbers.length === 0) {
    res.status(400).json({ error: "No dispatch text numbers configured for this client" });
    return;
  }

  const settings = await getSettings();
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const portalUrl = `${baseUrl}/portal/${slug}?token=${doc.portal_token}`;
  const message = settings.portal_sms_message.replace(
    /\{\{portal_url\}\}/g,
    portalUrl,
  );

  try {
    await sendSmsToAll(numbers, message);
    res.json({ success: true, sent_to: numbers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to send portal link", details: msg });
  }
});

// ── Global Settings ─────────────────────────────────────────────────────────

dashboardApiRouter.get("/settings", async (_req, res) => {
  res.json(await getSettings());
});

dashboardApiRouter.patch("/settings", requirePermission("manage_settings"), async (req, res) => {
  try {
    const updated = await updateSettings(req.body);
    await logAudit(req, "update_settings", "global", { fields: Object.keys(req.body) });
    alertRootIfNeeded(req, "update_settings", "global", Object.keys(req.body).join(", "));
    res.json({ success: true, settings: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── SMS Blast ───────────────────────────────────────────────────────────────

import { previewBlast, sendBlast } from "../../lib/blast-sms.js";

dashboardApiRouter.post("/blast-sms/preview", requirePermission("manage_settings"), (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }
  res.json(previewBlast(message));
});

dashboardApiRouter.post("/blast-sms", requirePermission("manage_settings"), async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.length > 1600) {
    res.status(400).json({ error: "message must be 1600 characters or fewer" });
    return;
  }

  try {
    const result = await sendBlast(message);
    await logAudit(req, "blast_sms", "global", {
      recipients: result.total_recipients,
      clients: result.total_clients,
      sent: result.sent,
      failed: result.failed.length,
      message: message.slice(0, 200),
    });
    alertRootIfNeeded(req, "blast_sms", "global", `${result.sent}/${result.total_recipients} sent to ${result.total_clients} clients`);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── Data Point Defaults ─────────────────────────────────────────────────────

dashboardApiRouter.get("/data-point-defaults", async (_req, res) => {
  const defaults = await getDataPointDefaultsWithCategory();
  const settings = await getSettings();
  const categoryOrder = settings.category_order || CATEGORY_ORDER;
  const categoryLabels = { ...CATEGORY_LABELS, ...(settings.category_labels || {}) };
  res.json({ defaults, categoryOrder, categoryLabels });
});

dashboardApiRouter.patch("/data-point-defaults/:key", requirePermission("manage_data_points"), async (req, res) => {
  const key = String(req.params.key);
  try {
    const updated = await updateDataPointDefault(key, req.body);
    if (!updated) {
      res.status(404).json({ error: `Data point "${key}" not found` });
      return;
    }
    res.json({ success: true, dataPoint: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

dashboardApiRouter.post("/data-point-defaults", requirePermission("manage_data_points"), async (req, res) => {
  try {
    const { key, label, category, type, choices, description, conversationPrompt, forwardCondition } = req.body;
    if (!key || !label) {
      res.status(400).json({ error: "key and label are required" });
      return;
    }
    const dp = await createDataPointDefault(key, {
      label, category, type, choices, description, conversationPrompt, forwardCondition,
    });
    await logAudit(req, "create_data_point", key);
    alertRootIfNeeded(req, "create_data_point", key);
    res.json({ success: true, dataPoint: dp });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ error: msg });
  }
});

dashboardApiRouter.put("/data-point-defaults/reorder", requirePermission("manage_data_points"), async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      res.status(400).json({ error: "items array is required" });
      return;
    }
    await reorderDataPointDefaults(items);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

dashboardApiRouter.delete("/data-point-defaults/:key", requirePermission("manage_data_points"), async (req, res) => {
  const key = String(req.params.key);
  try {
    const deleted = await deleteDataPointDefault(key);
    if (!deleted) {
      res.status(404).json({ error: `Data point "${key}" not found` });
      return;
    }
    await logAudit(req, "delete_data_point", key);
    alertRootIfNeeded(req, "delete_data_point", key);
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ error: msg });
  }
});

// ── User Management (admin only) ─────────────────────────────────────────────

dashboardApiRouter.get("/users", requirePermission("manage_users"), async (_req, res) => {
  const users = await listUsers();
  res.json(users);
});

dashboardApiRouter.post("/users", requirePermission("manage_users"), async (req, res) => {
  const { username, password, role, permissions } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    res.status(400).json({ error: "Username must be lowercase letters, numbers, and underscores only" });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  if (role !== "super_admin" && role !== "admin" && role !== "operator" && role !== "viewer") {
    res.status(400).json({ error: "Role must be 'admin', 'operator', or 'viewer'" });
    return;
  }
  try {
    await createUser(username, password, role, req.user?.username ?? "unknown", permissions);
    await logAudit(req, "create_user", username, { role });
    alertRootIfNeeded(req, "create_user", username, `role: ${role}`);
    res.json({ success: true, username, role });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ error: msg });
  }
});

dashboardApiRouter.patch("/users/:username/permissions", requirePermission("manage_users"), async (req, res) => {
  const target = String(req.params.username);
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== "object") {
    res.status(400).json({ error: "permissions object is required" });
    return;
  }
  const updated = await updateUserPermissions(target, permissions);
  if (!updated) {
    res.status(404).json({ error: `User "${target}" not found` });
    return;
  }
  await logAudit(req, "update_user_permissions", target, { permissions });
  alertRootIfNeeded(req, "update_user_permissions", target);
  res.json({ success: true });
});

dashboardApiRouter.delete("/users/:username", requirePermission("manage_users"), async (req, res) => {
  const target = String(req.params.username);
  if (target === req.user?.username) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  const deleted = await deleteUser(target);
  if (!deleted) {
    res.status(404).json({ error: `User "${target}" not found` });
    return;
  }
  await logAudit(req, "delete_user", target);
  alertRootIfNeeded(req, "delete_user", target);
  res.json({ success: true });
});

// ── Manual Backup ───────────────────────────────────────────────────────────

// Backup endpoint exposed via backupRouter (mounted outside /dashboard basic auth)
export const backupRouter = Router();
backupRouter.post("/", async (req, res) => {
  await logAudit(req, "trigger_backup", "manual");
  alertRootIfNeeded(req, "trigger_backup", "manual");
  const result = await runBackup();
  if (result.success) {
    res.json({ success: true, key: result.key });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});
