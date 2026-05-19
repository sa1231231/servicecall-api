import { Router } from "express";
import express from "express";
import { requireFeature } from "../../middleware/require-role.js";
import { requireServiceToken } from "../../middleware/require-service-token.js";
import {
  listPendingLeads,
  getPendingLead,
  updatePendingLead,
  markPromoted,
  markDismissed,
  type PendingLead,
  type PendingLeadStatus,
  type PendingLeadInput,
} from "../../lib/pending-leads.js";
import { runEnrichment, ingestLead } from "../../lib/lead-intake.js";
import { loadDraft, applyOverrides } from "../../lib/agent-from-draft.js";
import { createAgentFromConfig, type CreateAgentBody } from "../../lib/agent-from-config.js";
import { extractAreaCode } from "../../lib/provision-number.js";
import { areaCodeToTimezone } from "../../lib/area-code-timezone.js";
import { getSettings } from "../../lib/settings.js";

export const leadsRouter = Router();
leadsRouter.use(express.json());
// Router-level gate: anyone in the Pending Leads section needs at least
// read. Per-route mutation gates below add `write` for changes.
leadsRouter.use(requireFeature("pending_leads", "read"));

/** Headless intake for the Google Apps Script lead sync. Auth is a shared
 *  bearer token (LEAD_INTAKE_TOKEN), not a session. The operator-facing
 *  pause toggle (settings.lead_intake_enabled) gates this endpoint only —
 *  the manual `+ Add Lead` POST on `leadsRouter` is always live. */
export const leadsIntakeRouter = Router();
leadsIntakeRouter.use(express.json());
leadsIntakeRouter.use(requireServiceToken);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the promoted agent's `contact_notes` from a lead: the self-reported
 * business type plus enrichment-resolved website and location, then the
 * operator's own note. Returns `undefined` when there's nothing to set.
 *
 * Emits a fact block — one line per non-empty value:
 *   Business type: <X>
 *   Website: <X>
 *   Location: <city, state>
 * followed by a blank line + the operator note when both are present. Empty
 * strings (after trim) are treated as "not set" so an operator-cleared note
 * doesn't drag along a stray fact block, and vice versa.
 */
export function mergeContactNotesForPromote(opts: {
  businessType?: string;
  website?: string;
  city?: string;
  state?: string;
  operatorOverrideNotes?: string;
}): string | undefined {
  const operator = opts.operatorOverrideNotes?.trim();
  const facts: string[] = [];
  const bt = opts.businessType?.trim();
  if (bt) facts.push(`Business type: ${bt}`);
  const website = opts.website?.trim();
  if (website) facts.push(`Website: ${website}`);
  const loc = [opts.city?.trim(), opts.state?.trim()].filter(Boolean).join(", ");
  if (loc) facts.push(`Location: ${loc}`);
  const factBlock = facts.join("\n");
  if (!factBlock) return operator || undefined;
  return operator ? `${factBlock}\n\n${operator}` : factBlock;
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
  if (typeof b.business_type === "string" && b.business_type.trim()) {
    input.business_type = b.business_type.trim();
  }
  return input;
}

// ── Headless intake (Apps Script) ───────────────────────────────────────────

/** Token-authed intake for the Google Apps Script sync. Returns 423 when
 *  the operator has flipped the dashboard toggle off — Apps Script logs
 *  and skips on 423 instead of marking the row synced. */
leadsIntakeRouter.post("/", async (req, res) => {
  const settings = await getSettings();
  if (settings.lead_intake_enabled === false) {
    res.status(423).json({ error: "Lead intake paused" });
    return;
  }
  const input = sanitizeInput(req.body);
  if (!input) {
    res.status(400).json({ error: "`name` is required" });
    return;
  }
  const source = typeof req.body?.source === "string" && req.body.source.trim()
    ? req.body.source.trim()
    : "google_sheet";
  const externalId = typeof req.body?.externalId === "string" && req.body.externalId.trim()
    ? req.body.externalId.trim()
    : undefined;
  // Idempotent on externalId: when the source sheet has no STATUS column to
  // write the lead id back into, the client re-POSTs every row on every run.
  // ingestLead returns the existing lead instead of creating a duplicate;
  // 200 (vs 201) tells the client "already known, don't retry."
  const { lead, deduped } = await ingestLead({ source, input, externalId });
  res
    .status(deduped ? 200 : 201)
    .json({ _id: lead._id, status: lead.status, ...(deduped ? { deduped: true } : {}) });
});

// ── Routes ──────────────────────────────────────────────────────────────────

/** Intake. Accepts a raw lead, enrichment runs in the background. */
leadsRouter.post("/", requireFeature("pending_leads", "write"), async (req, res) => {
  const input = sanitizeInput(req.body);
  if (!input) {
    res.status(400).json({ error: "`name` is required" });
    return;
  }
  const source = typeof req.body?.source === "string" ? req.body.source : "manual";
  const { lead } = await ingestLead({ source, input });
  // Operator polls /api/leads/:id to see the status flip.
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

/** Operator edit — original lead fields, enriched fields, or status. */
leadsRouter.patch("/:id", requireFeature("pending_leads", "write"), async (req, res) => {
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
  // Editable original lead — sanitize so we don't store empty strings or
  // unexpected fields. Name remains required (non-empty after trim) so
  // the lead always has *something* to identify it by.
  if (body.input && typeof body.input === "object") {
    const sanitized = sanitizeInput(body.input);
    if (!sanitized) {
      res.status(400).json({ error: "Lead `input.name` cannot be empty" });
      return;
    }
    updates.input = sanitized;
  }
  if (body.enriched && typeof body.enriched === "object") {
    updates.enriched = {
      ...lead.enriched,
      ...body.enriched,
    };
  }
  if (typeof body.status === "string") {
    updates.status = body.status as PendingLeadStatus;
  }
  if (typeof body.externalId === "string" && body.externalId.trim()) {
    updates.externalId = body.externalId.trim();
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing editable in body" });
    return;
  }
  try {
    const updated = await updatePendingLead(id, updates);
    res.json(updated);
  } catch (err: any) {
    // Mongo unique-index violation when an externalId is already taken.
    if (err?.code === 11000) {
      res.status(409).json({ error: "externalId already in use by another lead" });
      return;
    }
    throw err;
  }
});

/** Re-run enrichment (e.g. after the operator added a website to the input). */
leadsRouter.post("/:id/re-enrich", requireFeature("pending_leads", "write"), async (req, res) => {
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
leadsRouter.post("/:id/dismiss", requireFeature("pending_leads", "write"), async (req, res) => {
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
leadsRouter.post("/:id/promote", requireFeature("pending_leads", "write"), async (req, res) => {
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

  // Carry the lead's contact info onto the new client doc so the agent's
  // Billing tab is pre-filled. The lead's phone area code drives
  // contact_timezone (overrides the dispatch-number-based auto-populate
  // in agent-from-config). Operator-supplied overrides in req.body.client
  // still win on top of these defaults.
  const leadContact: Partial<CreateAgentBody["client"]> = {};
  if (lead.input?.name) leadContact.contact_name = lead.input.name;
  if (lead.input?.phone) {
    leadContact.contact_phone = lead.input.phone;
    const tz = areaCodeToTimezone(extractAreaCode(lead.input.phone));
    if (tz) leadContact.contact_timezone = tz;
  }
  // Email isn't collected on the lead form — it only exists when enrichment
  // resolved one from the business's website/Facebook page. Often absent.
  const enrichedEmail = lead.enriched?.email?.trim();
  if (enrichedEmail) leadContact.contact_email = enrichedEmail;
  const operatorOverrides = (req.body?.client as Partial<CreateAgentBody["client"]> | undefined) ?? {};

  // Carry the lead's self-reported business type onto contact_notes so the
  // operator never loses that context after promotion. If the operator
  // also passed their own contact_notes in the override, prepend the
  // business type so neither is lost.
  const mergedNotes = mergeContactNotesForPromote({
    businessType: lead.input?.business_type,
    // Enrichment-resolved website wins; fall back to an operator-typed one.
    website: lead.enriched?.website || lead.input?.website,
    city: lead.enriched?.city,
    state: lead.enriched?.state,
    operatorOverrideNotes:
      typeof operatorOverrides.contact_notes === "string" ? operatorOverrides.contact_notes : undefined,
  });
  if (mergedNotes !== undefined) {
    // Set on operatorOverrides since it wins in the spread below.
    operatorOverrides.contact_notes = mergedNotes;
  }

  const fullBody = applyOverrides(draft.exportConfig, {
    business: { businessName, faqKnowledgeBase: faq },
    client: { ...leadContact, ...operatorOverrides },
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
