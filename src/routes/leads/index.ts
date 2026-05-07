import { Router } from "express";
import express from "express";
import { requirePermission } from "../../middleware/require-role.js";
import {
  createPendingLead,
  listPendingLeads,
  getPendingLead,
  updatePendingLead,
  markPromoted,
  markDismissed,
  type PendingLead,
  type PendingLeadStatus,
  type PendingLeadInput,
} from "../../lib/pending-leads.js";
import { enrichLead } from "../../lib/enrich-lead.js";
import { loadDraft, applyOverrides } from "../../lib/agent-from-draft.js";
import { createAgentFromConfig, type CreateAgentBody } from "../../lib/agent-from-config.js";

export const leadsRouter = Router();
leadsRouter.use(express.json());
leadsRouter.use(requirePermission("manage_leads"));

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run the Anthropic enrichment for a lead, then patch its status + enriched
 * fields (or its enrichmentError on failure). Best-effort — caller doesn't
 * await this so the intake POST returns immediately. Errors are surfaced to
 * the operator via the lead's `enrichmentError` field, not thrown.
 */
async function runEnrichment(leadId: string, input: PendingLeadInput): Promise<void> {
  // Clear the prior error when we restart so the UI doesn't show a stale
  // failure while the new attempt is in flight.
  await updatePendingLead(leadId, { status: "enriching", enrichmentError: undefined });
  const result = await enrichLead(input);
  // Both branches stash the AI conversation under enriched.extra so the
  // dashboard's AI Feed panel can render what we sent and what came back,
  // regardless of parse outcome. The success branch overwrites with fresh
  // structured data; the failure branch merges into prior enriched fields
  // so a failed re-enrich doesn't wipe operator edits.
  const aiTrace = {
    _userMessage: result.userMessage,
    _rawResponse: result.rawResponse,
  };
  if (result.ok) {
    await updatePendingLead(leadId, {
      status: "ready",
      enriched: {
        business_name: result.business_name,
        faqKnowledgeBase: result.faqKnowledgeBase,
        templateName: result.templateName,
        extra: { ...result.extra, ...aiTrace },
      },
      enrichmentError: undefined,
    });
  } else {
    const prior = await getPendingLead(leadId);
    const merged = {
      ...(prior?.enriched ?? {}),
      extra: {
        ...(prior?.enriched?.extra ?? {}),
        ...aiTrace,
      },
    };
    await updatePendingLead(leadId, {
      status: "failed",
      enrichmentError: result.error,
      enriched: merged,
    });
  }
}

function sanitizeInput(body: unknown): PendingLeadInput | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return null;
  const input: PendingLeadInput = { name };
  if (typeof b.phone === "string" && b.phone.trim()) input.phone = b.phone.trim();
  if (typeof b.website === "string" && b.website.trim()) input.website = b.website.trim();
  if (typeof b.notes === "string" && b.notes.trim()) input.notes = b.notes.trim();
  return input;
}

// ── Routes ──────────────────────────────────────────────────────────────────

/** Intake. Accepts a raw lead, enrichment runs in the background. */
leadsRouter.post("/", async (req, res) => {
  const input = sanitizeInput(req.body);
  if (!input) {
    res.status(400).json({ error: "`name` is required" });
    return;
  }
  const source = typeof req.body?.source === "string" ? req.body.source : "manual";
  const lead = await createPendingLead({ source, input });
  // Fire-and-forget — operator polls /api/leads/:id to see the status flip.
  runEnrichment(lead._id, input).catch((err) => {
    console.error(`[leads] enrichment crashed for ${lead._id}:`, err);
  });
  res.status(201).json(lead);
});

/** List the queue. Defaults to non-terminal statuses (queued/enriching/ready/failed). */
leadsRouter.get("/", async (req, res) => {
  const status = typeof req.query.status === "string"
    ? (req.query.status as PendingLeadStatus)
    : undefined;
  const includeTerminal = req.query.include_terminal === "1";
  const leads = await listPendingLeads({ status, includeTerminal });
  res.json(leads);
});

leadsRouter.get("/:id", async (req, res) => {
  const lead = await getPendingLead(String(req.params.id));
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  res.json(lead);
});

/** Operator edit — typically the enriched fields after a QA pass. */
leadsRouter.patch("/:id", async (req, res) => {
  const id = String(req.params.id);
  const lead = await getPendingLead(id);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  const body = req.body as Partial<PendingLead> | undefined;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Body required" });
    return;
  }
  const updates: Parameters<typeof updatePendingLead>[1] = {};
  if (body.enriched && typeof body.enriched === "object") {
    updates.enriched = {
      ...lead.enriched,
      ...body.enriched,
    };
  }
  if (typeof body.status === "string") {
    updates.status = body.status as PendingLeadStatus;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing editable in body" });
    return;
  }
  const updated = await updatePendingLead(id, updates);
  res.json(updated);
});

/** Re-run enrichment (e.g. after the operator added a website to the input). */
leadsRouter.post("/:id/re-enrich", async (req, res) => {
  const id = String(req.params.id);
  const lead = await getPendingLead(id);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  runEnrichment(id, lead.input).catch((err) => {
    console.error(`[leads] re-enrichment crashed for ${id}:`, err);
  });
  res.json({ success: true, status: "enriching" });
});

/** Soft-close a lead the operator decided not to convert. */
leadsRouter.post("/:id/dismiss", async (req, res) => {
  const id = String(req.params.id);
  const lead = await getPendingLead(id);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  await markDismissed(id);
  res.json({ success: true });
});

/**
 * Promote a lead → real Retell agent via the same path Quick Create uses.
 * Body: { draft: <name>, client?: Partial<CreateAgentBody["client"]> }.
 * The lead's `enriched.business_name` + `enriched.faqKnowledgeBase` flow
 * into the from-draft business overrides.
 */
leadsRouter.post("/:id/promote", async (req, res) => {
  const id = String(req.params.id);
  const lead = await getPendingLead(id);
  if (!lead) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  // Body's `draft` wins; otherwise fall back to the skill-suggested
  // template stored on the lead. Either way the operator can override
  // by sending an explicit `draft` in the request.
  const explicit = typeof req.body?.draft === "string" ? req.body.draft.trim() : "";
  const suggested = lead.enriched?.templateName?.trim() ?? "";
  const draftName = explicit || suggested;
  if (!draftName) {
    res.status(400).json({
      error:
        "Missing required field: draft (draft name). The lead has no skill-suggested template either — pass `draft` explicitly.",
    });
    return;
  }
  const businessName = lead.enriched?.business_name?.trim();
  const faq = lead.enriched?.faqKnowledgeBase?.trim();
  if (!businessName || !faq) {
    res.status(400).json({
      error:
        "Lead is missing enriched business_name or faqKnowledgeBase — fill them in or re-enrich first.",
    });
    return;
  }

  const draft = await loadDraft(draftName);
  if (!draft) {
    res.status(404).json({ error: `Draft "${draftName}" not found` });
    return;
  }
  if (!draft.exportConfig) {
    res.status(400).json({
      error: `Draft "${draftName}" lacks programmatic config`,
      details:
        "Open the draft in the agent form and click 'Save Draft' once to migrate it.",
    });
    return;
  }

  const fullBody = applyOverrides(draft.exportConfig, {
    business: { businessName, faqKnowledgeBase: faq },
    client: req.body?.client as Partial<CreateAgentBody["client"]> | undefined,
  });

  const result = await createAgentFromConfig(fullBody);
  if (!result.ok) {
    res.status(result.status).json({
      error: result.error,
      ...(result.details !== undefined ? { details: result.details } : {}),
    });
    return;
  }
  await markPromoted(id, result.slug);
  res.status(201).json({
    success: true,
    slug: result.slug,
    agent_id: result.agentId,
    provisioned_number: result.provisionedNumber,
    provision_error: result.provisionError,
  });
});
