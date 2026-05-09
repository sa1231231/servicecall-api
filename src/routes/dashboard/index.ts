import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Router } from "express";
import express from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { listAgentsHandler } from "./list-agents.js";
import { auditLogHandler } from "./audit-log.js";
import { listPhoneNumbersHandler } from "./list-phone-numbers.js";
import { toggleShadowHandler } from "./toggle-shadow.js";
import { toggleActiveHandler } from "./toggle-active.js";
import { getAgentHandler } from "./get-agent.js";
import { getCallsHandler } from "./get-calls.js";
import { updateAgentHandler } from "./update-agent.js";
import { cloneAgentHandler } from "./clone-agent.js";
import { deleteAgentHandler } from "./delete-agent.js";
import {
  listFoldersHandler,
  createFolderHandler,
  updateFolderHandler,
  deleteFolderHandler,
} from "./folders.js";
import { moveAgentFolderHandler } from "./move-agent-folder.js";
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
import { validateGlobalSettingsUpdates } from "../../lib/validate-client-fields.js";
import { runBackup } from "../../lib/backup.js";
import {
  getDataPointDefaultsWithCategory,
  getDataPointDefault,
  updateDataPointDefault,
  createDataPointDefault,
  deleteDataPointDefault,
  reorderDataPointDefaults,
  countDataPointsInCategory,
  listUsedCategories,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
} from "../../lib/data-point-defaults.js";
import {
  requireRoot,
  requireRootForProtectedSlug,
  requireFeature,
  requireSuperAdminOrRoot,
} from "../../middleware/require-role.js";
import { logAudit } from "../../lib/audit.js";
import { nodeEditorRouter } from "./node-editor.js";
import { alertRootIfNeeded } from "../../lib/root-alerts.js";
import {
  listUsers,
  resolvePermissions,
  PERMISSION_DEFS,
  DEFAULT_PERMISSIONS,
  createUser,
  deleteUser,
  updateUserPermissions,
  updateUserFeaturePermissions,
} from "../../lib/users.js";
import { PERMISSION_CATALOG } from "../../lib/permission-catalog.js";
import {
  getAllRoleDefaults,
  setRoleDefaults,
  ROLES as ROLE_DEFAULT_ROLES,
  type Role as RoleDefaultsRole,
} from "../../lib/role-defaults.js";
import { FEATURES, SEED_FEATURE_DEFAULTS } from "../../lib/feature-permissions.js";

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
    user: req.user
      ? {
          username: req.user.username,
          role: req.user.role,
          permissions: req.user.permissions,
          featurePermissions: req.user.featurePermissions,
          isRoot: req.user.isRoot,
        }
      : null,
    // Legacy maps — kept for any UI still reading them.
    permissionDefs: PERMISSION_DEFS,
    defaultPermissions: DEFAULT_PERMISSIONS,
    permissionCatalog: PERMISSION_CATALOG,
    // New shape: FEATURES + role-default seed.
    features: FEATURES,
    seedFeatureDefaults: SEED_FEATURE_DEFAULTS,
  });
});

// Authenticated API routes
export const dashboardApiRouter = Router();
dashboardApiRouter.use(express.json());

dashboardApiRouter.get("/agents", listAgentsHandler);
dashboardApiRouter.get("/phone-numbers", listPhoneNumbersHandler);
dashboardApiRouter.get("/audit-log", requireFeature("audit_log", "read"), auditLogHandler);
dashboardApiRouter.get("/agents/:slug", getAgentHandler);
dashboardApiRouter.get("/agents/:slug/calls", getCallsHandler);
dashboardApiRouter.patch("/agents/:slug/shadow", requireFeature("agent_config", "write"), toggleShadowHandler);
dashboardApiRouter.patch("/agents/:slug/active", requireFeature("agent_config", "write"), toggleActiveHandler);
dashboardApiRouter.patch("/agents/:slug", requireFeature("agent_config", "write"), updateAgentHandler);
dashboardApiRouter.post("/agents/:slug/clone", requireFeature("agent_lifecycle", "write"), cloneAgentHandler);
dashboardApiRouter.delete("/agents/:slug", requireRootForProtectedSlug, requireFeature("agent_lifecycle", "manage"), deleteAgentHandler);
dashboardApiRouter.patch("/agents/:slug/folder", requireFeature("folders", "write"), moveAgentFolderHandler);

// ── Folders ─────────────────────────────────────────────────────────────────
// Read is open to any dashboard viewer; mutations require folders:write.
// Deleting a folder moves its agents back to "Unfiled" (root) — never deletes
// the agents themselves, so it's still scoped to folders:manage.
dashboardApiRouter.get("/folders", listFoldersHandler);
dashboardApiRouter.post("/folders", requireFeature("folders", "write"), createFolderHandler);
dashboardApiRouter.patch("/folders/:id", requireFeature("folders", "write"), updateFolderHandler);
dashboardApiRouter.delete("/folders/:id", requireFeature("folders", "manage"), deleteFolderHandler);

// ── Export ───────────────────────────────────────────────────────────────────
import { exportAgentHandler } from "../agents/export-agent.js";
dashboardApiRouter.get("/agents/:slug/export", exportAgentHandler);

// ── Node Editor ──────────────────────────────────────────────────────────────
// The router itself only requires read; per-route gates inside node-editor.ts
// add write/manage where needed.
dashboardApiRouter.use("/agents/:slug/nodes", requireFeature("node_editor", "read"), nodeEditorRouter);

// ── Soft-Deleted Agents (Recovery) ──────────────────────────────────────────

dashboardApiRouter.get("/deleted-agents", requireFeature("permanent_delete", "read"), async (_req, res) => {
  const deleted = await listDeletedClients();
  res.json(deleted);
});

dashboardApiRouter.post("/deleted-agents/:slug/restore", requireFeature("permanent_delete", "write"), async (req, res) => {
  const slug = String(req.params.slug);
  try {
    // Restore the Retell agent names (strip "[DELETED — expires ...]" suffix)
    const doc = await getClientDocument(slug);
    if (doc) {
      const retell = new Retell({ apiKey: config.RETELL_API_KEY });
      const deletedPattern = /\s*\[DELETED — expires \d{4}-\d{2}-\d{2}\]$/;
      const allIds = new Set([
        ...Object.keys(doc.retell_agents ?? {}),
        ...(doc.agent_id ? [doc.agent_id] : []),
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

dashboardApiRouter.delete("/deleted-agents/:slug", requireRootForProtectedSlug, requireFeature("permanent_delete", "manage"), async (req, res) => {
  const slug = String(req.params.slug);
  try {
    const doc = await getClientDocument(slug);
    let release: { released: Array<{ phone_number: string; phone_number_sid: string }>; errors: string[] } | undefined;
    if (doc) {
      const { releaseAgentResources } = await import("../../lib/release-agent-resources.js");
      release = await releaseAgentResources(slug, doc, "permanent-delete");
    }

    await deleteClient(slug);
    await logAudit(req, "permanent_delete_agent", slug, release ? {
      released_numbers: release.released,
      cleanup_errors: release.errors,
    } : undefined);
    alertRootIfNeeded(req, "permanent_delete_agent", slug);
    const response: Record<string, unknown> = { success: true, slug };
    if (release) {
      response.released_numbers = release.released;
      if (release.errors.length > 0) response.cleanup_errors = release.errors;
    }
    res.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

dashboardApiRouter.get("/agents/:slug/calls/:callId/transcript", async (req, res) => {
  const { slug, callId } = req.params;
  const callLog = await getCallLogById(callId);
  // Identical 404 for "doesn't exist", "exists but wrong slug", and
  // "exists but transcript not ready" so an attacker can't enumerate
  // call IDs across slugs by inspecting the error message.
  if (!callLog || callLog.client_slug !== slug || !callLog.transcript) {
    res.status(404).json({ error: "Call not found" });
    return;
  }
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="transcript-${callId}.txt"`);
  res.send(callLog.transcript);
});

dashboardApiRouter.get("/agents/:slug/portal-token", requireFeature("global_settings", "write"), async (req, res) => {
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

dashboardApiRouter.post("/agents/:slug/portal-token", requireFeature("global_settings", "write"), async (req, res) => {
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

dashboardApiRouter.post("/agents/:slug/request-review", requireFeature("send_comms", "write"), async (req, res) => {
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

// Send carrier-specific setup instructions. The body is `{ id }` referring
// to one of the `setup_instructions` entries configured globally. Mirrors
// the request-review handler — looks up the template, substitutes vars,
// and SMS-blasts the client's dispatch numbers.
dashboardApiRouter.post("/agents/:slug/send-instructions", requireFeature("send_comms", "write"), async (req, res) => {
  const slug = String(req.params.slug);
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  if (!id) {
    res.status(400).json({ error: "Body must include `id` of the instruction template" });
    return;
  }

  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  const settings = await getSettings();
  const template = (settings.setup_instructions ?? []).find((t) => t.id === id);
  if (!template) {
    res.status(404).json({ error: `No setup instruction template with id "${id}"` });
    return;
  }

  const numbers = doc.dispatch_text_numbers ?? [];
  if (numbers.length === 0) {
    res.status(400).json({ error: "No dispatch text numbers configured for this client" });
    return;
  }

  // {{agent_phone}}        → E.164 form, e.g. "+18158804070"
  // {{agent_phone_10}}     → 10-digit US form, e.g. "8158804070" — for use
  //   inside carrier star/MMI codes (`*72{{agent_phone_10}}`,
  //   `**21*{{agent_phone_10}}#`) where the `+1` country prefix can break
  //   tap-to-dial activation on some carriers/dialers.
  // {{agent_phone_pretty}} → human-readable US form, e.g. "(815) 880-4070"
  //   — for hosted-PBX UIs like RingCentral that want a display-formatted
  //   number in the forwarding-target field.
  //
  // Source-of-truth chain: doc.outbound_from_number (fast path) → Retell
  // live (fallback for legacy agents whose outbound_from_number was
  // never persisted because of a bug in the older create flow). Falling
  // back to Retell live also catches manual rebinds done in the Retell
  // console without re-running our provision flow.
  let e164 = doc.outbound_from_number ?? "";
  if (!e164 && doc.agent_id) {
    try {
      const Retell = (await import("retell-sdk")).default;
      const retell = new Retell({ apiKey: config.RETELL_API_KEY });
      const allNumbers = await retell.phoneNumber.list();
      const bound = allNumbers.find((n) =>
        (n.inbound_agents ?? []).some((a) => a.agent_id === doc.agent_id)
      );
      if (bound) {
        e164 = bound.phone_number;
        console.log(`[send-instructions] resolved {{agent_phone}} for "${slug}" via Retell-live fallback: ${e164}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[send-instructions] Retell phoneNumber.list failed for "${slug}": ${msg}`);
    }
  }
  const tenDigit = e164.replace(/^\+1/, "").replace(/^\+/, "").replace(/\D/g, "").slice(-10);
  if (!tenDigit) {
    res.status(400).json({
      error: "No phone number resolved for this agent (outbound_from_number is empty and Retell has no inbound binding). Provision a number for this agent first.",
    });
    return;
  }
  const pretty = tenDigit.length === 10
    ? `(${tenDigit.slice(0, 3)}) ${tenDigit.slice(3, 6)}-${tenDigit.slice(6)}`
    : e164;
  const message = template.message
    .replace(/\{\{business_name\}\}/g, doc.name ?? "")
    .replace(/\{\{agent_phone_pretty\}\}/g, pretty)
    .replace(/\{\{agent_phone_10\}\}/g, tenDigit)
    .replace(/\{\{agent_phone\}\}/g, e164);

  try {
    await sendSmsToAll(numbers, message);
    res.json({ success: true, sent_to: numbers, label: template.label });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to send setup instructions", details: msg });
  }
});

dashboardApiRouter.post("/agents/:slug/send-payment-link", requireFeature("send_comms", "write"), async (req, res) => {
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

dashboardApiRouter.post("/agents/:slug/send-portal-link", requireFeature("send_comms", "write"), async (req, res) => {
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

// ── Billing / COGS ──────────────────────────────────────────────────────────

import { getClientCogs } from "../../lib/billing-cogs.js";

dashboardApiRouter.get("/billing/cogs/:slug", async (req, res) => {
  try {
    const slug = req.params.slug;
    const monthsBack = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
    const cogs = await getClientCogs(slug, monthsBack);
    res.json(cogs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[billing/cogs] error:`, msg);
    res.status(500).json({ error: msg });
  }
});

// ── Global Settings ─────────────────────────────────────────────────────────

dashboardApiRouter.get("/settings", async (_req, res) => {
  res.json(await getSettings());
});

dashboardApiRouter.patch("/settings", requireFeature("global_settings", "write"), async (req, res) => {
  const validationErrors = validateGlobalSettingsUpdates(req.body || {});
  if (validationErrors.length > 0) {
    res.status(400).json({ error: validationErrors.join("; "), errors: validationErrors });
    return;
  }
  try {
    const before = (await getSettings()) ?? {};
    const updated = await updateSettings(req.body);
    const fields = Object.keys(req.body);
    const beforeRec = before as unknown as Record<string, unknown>;
    const updatedRec = (updated ?? {}) as unknown as Record<string, unknown>;
    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of fields) {
      diff[k] = { before: beforeRec[k], after: updatedRec[k] };
    }
    await logAudit(req, "update_settings", "global", { fields, diff });
    alertRootIfNeeded(req, "update_settings", "global", fields.join(", "));
    res.json({ success: true, settings: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── SMS Blast ───────────────────────────────────────────────────────────────

import { previewBlast, sendBlast } from "../../lib/blast-sms.js";

dashboardApiRouter.post("/blast-sms/preview", requireFeature("sms_blast", "read"), (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required" });
    return;
  }
  res.json(previewBlast(message));
});

dashboardApiRouter.post("/blast-sms", requireFeature("sms_blast", "write"), async (req, res) => {
  const { message, confirm, confirm_recipients } = req.body;
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.length > 1600) {
    res.status(400).json({ error: "message must be 1600 characters or fewer" });
    return;
  }

  // Two-step gate: client must preview first, then send the same message
  // along with the recipient count and an explicit confirm flag. This
  // prevents an accidental blast (or a raw HTTP POST) from going out
  // without the operator having seen the impact.
  if (confirm !== true) {
    res.status(400).json({ error: "confirm: true is required to send a blast" });
    return;
  }
  const preview = previewBlast(message);
  if (typeof confirm_recipients !== "number" || !Number.isInteger(confirm_recipients) || confirm_recipients < 0) {
    res.status(400).json({ error: "confirm_recipients (number) is required" });
    return;
  }
  if (confirm_recipients !== preview.total_recipients) {
    res.status(409).json({
      error: `Recipient count changed since preview (preview: ${confirm_recipients}, now: ${preview.total_recipients}). Re-preview and re-send.`,
      preview_recipient_count: confirm_recipients,
      current_recipient_count: preview.total_recipients,
    });
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

dashboardApiRouter.patch("/data-point-defaults/:key", requireFeature("data_point_defaults", "write"), async (req, res) => {
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

dashboardApiRouter.post("/data-point-defaults", requireFeature("data_point_defaults", "write"), async (req, res) => {
  try {
    const { key, label, category, type, choices, description, conversationPrompt, forwardCondition, composite, variables } = req.body;
    if (!key || !label) {
      res.status(400).json({ error: "key and label are required" });
      return;
    }
    const dp = await createDataPointDefault(key, {
      label, category, type, choices, description, conversationPrompt, forwardCondition, composite, variables,
    });
    await logAudit(req, "create_data_point", key);
    alertRootIfNeeded(req, "create_data_point", key);
    res.json({ success: true, dataPoint: dp });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ error: msg });
  }
});

dashboardApiRouter.put("/data-point-defaults/reorder", requireFeature("data_point_defaults", "write"), async (req, res) => {
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

dashboardApiRouter.delete("/data-point-defaults/:key", requireFeature("data_point_defaults", "manage"), async (req, res) => {
  const key = String(req.params.key);
  try {
    // Snapshot the dp's category before deletion so we can decide whether
    // to cascade-cleanup the category once it's empty. Built-in categories
    // (CATEGORY_ORDER) are protected from auto-cleanup so they always stay
    // available as targets in the dropdown.
    const existing = await getDataPointDefault(key);
    const category = existing?.category;

    const deleted = await deleteDataPointDefault(key);
    if (!deleted) {
      res.status(404).json({ error: `Data point "${key}" not found` });
      return;
    }
    await logAudit(req, "delete_data_point", key);
    alertRootIfNeeded(req, "delete_data_point", key);

    // Cascade: if the dp's category is now empty AND the category isn't
    // a built-in, drop it from settings.category_order + category_labels
    // so empty user-managed categories don't accumulate as orphans.
    let categoryRemoved: string | undefined;
    if (category && !CATEGORY_ORDER.includes(category)) {
      const remaining = await countDataPointsInCategory(category);
      if (remaining === 0) {
        const settings = await getSettings();
        const order = settings.category_order ? settings.category_order.filter((c) => c !== category) : undefined;
        const labels = settings.category_labels ? { ...settings.category_labels } : undefined;
        if (labels) delete labels[category];
        const updates: Partial<typeof settings> = {};
        if (order && (settings.category_order ?? []).includes(category)) updates.category_order = order;
        if (labels && (settings.category_labels ?? {})[category] !== undefined) updates.category_labels = labels;
        if (Object.keys(updates).length > 0) {
          await updateSettings(updates);
          categoryRemoved = category;
          console.log(`[data-point-defaults] cascade-removed empty category "${category}" from settings`);
        }
      }
    }

    res.json({ success: true, ...(categoryRemoved ? { categoryRemoved } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ error: msg });
  }
});

/** One-shot cleanup of orphaned categories: any entry in
 *  settings.category_order or settings.category_labels that is not a
 *  built-in AND has zero data points referencing it gets removed.
 *  Idempotent. Admin-only. */
dashboardApiRouter.post("/data-point-defaults/cleanup-orphan-categories", requireFeature("data_point_defaults", "manage"), async (req, res) => {
  try {
    const settings = await getSettings();
    const used = new Set(await listUsedCategories());
    const builtin = new Set(CATEGORY_ORDER);

    const order = settings.category_order ?? [];
    const labels = settings.category_labels ?? {};
    const orphans: string[] = [];

    for (const cat of order) {
      if (!builtin.has(cat) && !used.has(cat)) orphans.push(cat);
    }
    for (const cat of Object.keys(labels)) {
      if (!builtin.has(cat) && !used.has(cat) && !orphans.includes(cat)) orphans.push(cat);
    }

    if (orphans.length === 0) {
      res.json({ success: true, removed: [] });
      return;
    }

    const newOrder = order.filter((c) => !orphans.includes(c));
    const newLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (!orphans.includes(k)) newLabels[k] = v;
    }

    const updates: Partial<typeof settings> = {};
    if (settings.category_order !== undefined) updates.category_order = newOrder;
    if (settings.category_labels !== undefined) updates.category_labels = newLabels;
    if (Object.keys(updates).length > 0) await updateSettings(updates);

    await logAudit(req, "cleanup_orphan_categories", orphans.join(","));
    res.json({ success: true, removed: orphans });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

// ── User Management (admin only) ─────────────────────────────────────────────

dashboardApiRouter.get("/users", requireSuperAdminOrRoot, async (_req, res) => {
  const users = await listUsers();
  // Return resolved/effective permissions so the UI matches what
  // requirePermission(...) actually enforces. For super_admin and
  // admin, role defaults override the stored map (any keys added to
  // PERMISSION_DEFS after a user was created appear correctly).
  res.json(users.map((u) => ({
    ...u,
    permissions: resolvePermissions(u.role, u.permissions),
  })));
});

dashboardApiRouter.post("/users", requireSuperAdminOrRoot, async (req, res) => {
  const { username, password, role, feature_permissions } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    res.status(400).json({ error: "Username must be lowercase letters, numbers, and underscores only" });
    return;
  }
  if (password.length < 12) {
    res.status(400).json({ error: "Password must be at least 12 characters" });
    return;
  }
  if (role !== "super_admin" && role !== "admin" && role !== "operator" && role !== "viewer") {
    res.status(400).json({ error: "Role must be 'super_admin', 'admin', 'operator', or 'viewer'" });
    return;
  }
  try {
    await createUser(username, password, role, req.user?.username ?? "unknown", feature_permissions);
    await logAudit(req, "create_user", username, { role });
    alertRootIfNeeded(req, "create_user", username, `role: ${role}`);
    res.json({ success: true, username, role });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ error: msg });
  }
});

dashboardApiRouter.patch("/users/:username/permissions", requireSuperAdminOrRoot, async (req, res) => {
  const target = String(req.params.username);
  // Accept either the new shape (feature_permissions) or the legacy shape
  // (permissions: {key: bool}). Prefer the new shape; fall back to the
  // legacy update for backwards compat with any external caller.
  const featurePerms = req.body?.feature_permissions;
  const legacyPerms = req.body?.permissions;
  if (featurePerms && typeof featurePerms === "object") {
    const updated = await updateUserFeaturePermissions(target, featurePerms);
    if (!updated) {
      res.status(404).json({ error: `User "${target}" not found` });
      return;
    }
    await logAudit(req, "update_user_permissions", target, { feature_permissions: featurePerms });
  } else if (legacyPerms && typeof legacyPerms === "object") {
    const updated = await updateUserPermissions(target, legacyPerms);
    if (!updated) {
      res.status(404).json({ error: `User "${target}" not found` });
      return;
    }
    await logAudit(req, "update_user_permissions", target, { permissions: legacyPerms });
  } else {
    res.status(400).json({ error: "Body must include feature_permissions: {feature: level} or permissions: {key: bool}" });
    return;
  }
  alertRootIfNeeded(req, "update_user_permissions", target);
  res.json({ success: true });
});

dashboardApiRouter.delete("/users/:username", requireSuperAdminOrRoot, async (req, res) => {
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

// ── Role Defaults ───────────────────────────────────────────────────────────
//
// Read: anyone with manage_users (so admins can audit but not edit).
// Write: super_admin or root only — flipping operator/viewer defaults
// affects every user without an explicit per-user override and is the
// kind of change that warrants the highest gate.

dashboardApiRouter.get("/role-defaults", requireSuperAdminOrRoot, async (_req, res) => {
  try {
    const all = await getAllRoleDefaults();
    res.json(all);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

dashboardApiRouter.patch("/role-defaults/:role", async (req, res) => {
  // Custom gate: super_admin OR root. Not a single requirePermission(...)
  // call because no permission key represents "edit role defaults"
  // (that would be circular — admins could grant themselves the perm).
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (req.user.role !== "super_admin" && !req.user.isRoot) {
    res.status(403).json({ error: "Only super_admin or root can edit role defaults" });
    return;
  }
  const role = String(req.params.role) as RoleDefaultsRole;
  if (!ROLE_DEFAULT_ROLES.includes(role)) {
    res.status(400).json({ error: `Unknown role "${role}"` });
    return;
  }
  const perms = (req.body && typeof req.body === "object" ? req.body.permissions : null) as Record<string, string> | null;
  if (!perms || typeof perms !== "object") {
    res.status(400).json({ error: "Body must include permissions: {feature: level}" });
    return;
  }
  try {
    const before = await getAllRoleDefaults();
    const after = await setRoleDefaults(
      role,
      perms as unknown as Record<string, import("../../lib/feature-permissions.js").Level>,
      req.user.username,
    );
    const beforePerms = before[role];
    // Compute a per-feature diff (level before → level after) for the
    // audit log so reviews are scannable.
    const diff: Record<string, { before: string; after: string }> = {};
    for (const key of Object.keys(after)) {
      const beforeVal = String(beforePerms[key] ?? "none");
      const afterVal = String(after[key] ?? "none");
      if (beforeVal !== afterVal) diff[key] = { before: beforeVal, after: afterVal };
    }
    await logAudit(req, "update_role_defaults", role, { diff });
    alertRootIfNeeded(req, "update_role_defaults", role, Object.keys(diff).join(", ") || "no changes");
    res.json({ success: true, role, permissions: after, changed: Object.keys(diff) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
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
