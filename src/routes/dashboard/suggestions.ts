// Operator-facing routes for the transcript-review system. Mounts at
// /dashboard/api/* — all gated by sessionAuth (parent router) and per-action
// `requireFeature("transcript_review", level)` here.
//
// The approve handler is the load-bearing piece: it builds a save-and-publish
// payload via the applier, forwards to the existing saveAndPublishHandler
// using a captured-response shim, then persists the suggestion's status.

import { Router, type Request, type Response } from "express";
import express from "express";
import { ObjectId } from "mongodb";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { requireFeature } from "../../middleware/require-role.js";
import {
  getSuggestion,
  listSuggestions,
  updateSuggestion,
} from "../../lib/improvement-suggestions.js";
import {
  buildPublishPayload,
  buildSnapshotFromCanonical,
} from "../../lib/suggestion-applier.js";
import { applyToDraft } from "../../lib/draft-applier.js";
import { getClientDocument } from "../../config/client-store.js";
import { logAudit } from "../../lib/audit.js";
import { saveAndPublishHandler, rollbackToVersionHandler } from "./node-editor.js";
import { getLatestVersion, getPreviousVersion } from "../../lib/agent-versions.js";
import { loadDraft, updateDraftExportConfig } from "../../lib/agent-from-draft.js";
import { analyzeAndPersist } from "../../lib/transcript-review.js";

export const suggestionsRouter = Router();
suggestionsRouter.use(express.json());

// ── List for an agent ───────────────────────────────────────────────────────
//
// Includes a `bubble_up` envelope describing whether approvals on this
// agent can also write to the source draft. The UI uses it to decide
// whether to render the "apply to template" button next to "apply to agent".

suggestionsRouter.get(
  "/agents/:slug/suggestions",
  requireFeature("transcript_review", "read"),
  async (req, res) => {
    const slug = String(req.params.slug);
    const status = parseStatus(req.query.status);
    const limit = clamp(Number(req.query.limit) || 50, 1, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [suggestions, bubbleUp] = await Promise.all([
      listSuggestions({ clientSlug: slug, status, limit, offset }),
      computeBubbleUpEligibility(slug),
    ]);
    res.json({ suggestions, bubble_up: bubbleUp });
  },
);

async function computeBubbleUpEligibility(slug: string): Promise<{
  eligible: boolean;
  source_draft?: string;
  reason?: string;
}> {
  const doc = await getClientDocument(slug);
  if (!doc) return { eligible: false, reason: "client_not_found" };
  if (!doc.source_draft) {
    return { eligible: false, reason: "no_source_draft" };
  }
  const draft = await loadDraft(doc.source_draft);
  if (!draft) {
    return { eligible: false, source_draft: doc.source_draft, reason: "draft_missing" };
  }
  if (!draft.is_template) {
    return { eligible: false, source_draft: doc.source_draft, reason: "not_template" };
  }
  if (!draft.exportConfig) {
    return {
      eligible: false,
      source_draft: doc.source_draft,
      reason: "draft_lacks_export_config",
    };
  }
  return { eligible: true, source_draft: doc.source_draft };
}

// ── Inbox (cross-agent) ─────────────────────────────────────────────────────

suggestionsRouter.get(
  "/suggestions",
  requireFeature("transcript_review", "read"),
  async (req, res) => {
    const status = parseStatus(req.query.status) ?? "pending";
    const limit = clamp(Number(req.query.limit) || 50, 1, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const suggestions = await listSuggestions({ status, limit, offset });
    res.json({ suggestions });
  },
);

// ── Detail ──────────────────────────────────────────────────────────────────

suggestionsRouter.get(
  "/suggestions/:id",
  requireFeature("transcript_review", "read"),
  async (req, res) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid suggestion id" });
      return;
    }
    const suggestion = await getSuggestion(id);
    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    res.json({ suggestion });
  },
);

// ── Approve (the load-bearing one) ──────────────────────────────────────────

suggestionsRouter.post(
  "/suggestions/:id/approve",
  requireFeature("transcript_review", "write"),
  async (req, res) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid suggestion id" });
      return;
    }
    const suggestion = await getSuggestion(id);
    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    if (suggestion.status !== "pending") {
      res.status(409).json({ error: `Suggestion already ${suggestion.status}` });
      return;
    }
    if (suggestion.scope !== "agent") {
      res.status(400).json({ error: `Only agent-scoped suggestions are supported (got scope=${suggestion.scope})` });
      return;
    }

    // The operator chooses scope per approval:
    //   "agent" (default) — apply to this agent only
    //   "agent_and_draft" — also write the change into the source draft so
    //                       every future agent built from it inherits the fix
    // Anything else, or "agent_and_draft" without a valid template-marked
    // source draft, falls back to "agent" with a warning so the approve
    // never silently no-ops.
    const requestedScope = req.body?.scope === "agent_and_draft" ? "agent_and_draft" : "agent";

    const clientDoc = await getClientDocument(suggestion.client_slug);
    if (!clientDoc) {
      res.status(404).json({ error: `Client "${suggestion.client_slug}" not found` });
      return;
    }
    const canonical = clientDoc.retell_agents?.[suggestion.agent_id];
    if (!canonical) {
      res.status(404).json({ error: `Canonical JSON for agent ${suggestion.agent_id} not found` });
      return;
    }

    const snapshot = buildSnapshotFromCanonical(canonical);
    const applied = buildPublishPayload(suggestion.proposed_change, snapshot);
    if (!applied.ok) {
      // Advisory-only suggestions are recorded as `applied` with no
      // version_id, since the operator handles them by hand. The dashboard
      // should surface the description so they know what to do.
      if (applied.advisoryOnly) {
        const updated = await updateSuggestion(id, {
          status: "applied",
          applied_at: new Date(),
          decided_by: req.user?.username,
          decision_note: `advisory: ${applied.error}`,
        });
        await logAudit(req, "approve_transcript_suggestion_advisory", suggestion.client_slug, {
          suggestionId: id,
          type: suggestion.type,
          reason: applied.error,
        });
        res.json({ success: true, advisory: true, message: applied.error, suggestion: updated });
        return;
      }
      res.status(400).json({ error: applied.error });
      return;
    }

    // Forward to save-and-publish via captured-response proxy. We can't
    // reuse the live `res` because saveAndPublishHandler wants to send its
    // own response; we want to send ours. Trade-off: small adapter, no fork
    // of the publish logic.
    const captured: { status: number; body: unknown } = { status: 200, body: undefined };
    const proxyRes = makeCapturedResponse(captured);

    const proxyReq = req as unknown as Request & {
      params: Record<string, string>;
      body: Record<string, unknown>;
    };
    proxyReq.params = { slug: suggestion.client_slug, agentId: suggestion.agent_id };
    proxyReq.body = applied.payload;

    try {
      await saveAndPublishHandler(proxyReq as Parameters<typeof saveAndPublishHandler>[0], proxyRes, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `save-and-publish threw: ${msg}` });
      return;
    }

    if (captured.status >= 400) {
      // Validation failure or Retell push error — leave the suggestion as
      // pending so the operator can retry or reject.
      res.status(captured.status).json(captured.body);
      return;
    }

    // Look up the version snapshot the publish just created so we can link
    // it on the suggestion (for audit / rollback).
    const latestVersion = await getLatestVersion(suggestion.client_slug, suggestion.agent_id);

    // Bubble-up: if requested AND lineage qualifies, mutate the source
    // draft's exportConfig. We *never* fail the operator's approve action
    // because the draft step missed — the agent already got the change, so
    // we record what bubbled up and what didn't and respond accordingly.
    let draftOutcome:
      | { ok: true; draftName: string; description: string }
      | { ok: false; draftName?: string; reason: string }
      | null = null;
    if (requestedScope === "agent_and_draft") {
      draftOutcome = await tryBubbleUpToDraft(clientDoc.source_draft, suggestion.proposed_change);
    }

    const updated = await updateSuggestion(id, {
      status: "applied",
      applied_at: new Date(),
      applied_version_id: latestVersion?._id?.toString(),
      decided_by: req.user?.username,
      decision_note: draftOutcome?.ok
        ? `${applied.description} (also: ${draftOutcome.description})`
        : applied.description,
    });

    await logAudit(req, "approve_transcript_suggestion", suggestion.client_slug, {
      suggestionId: id,
      type: suggestion.type,
      applied_version_id: latestVersion?._id?.toString(),
      description: applied.description,
      scope: requestedScope,
      draft_outcome: draftOutcome ?? "not_requested",
    });

    res.json({
      success: true,
      suggestion: updated,
      version_id: latestVersion?._id?.toString(),
      draft_propagation: draftOutcome,
    });
  },
);

// ── Bubble-up helper ────────────────────────────────────────────────────────

async function tryBubbleUpToDraft(
  sourceDraftName: string | undefined,
  proposed: import("../../lib/call-findings.js").ProposedChange,
): Promise<
  | { ok: true; draftName: string; description: string }
  | { ok: false; draftName?: string; reason: string }
> {
  if (!sourceDraftName) {
    return { ok: false, reason: "Agent has no source_draft — nothing to bubble up to." };
  }
  const draft = await loadDraft(sourceDraftName);
  if (!draft) {
    return { ok: false, draftName: sourceDraftName, reason: `Source draft "${sourceDraftName}" not found.` };
  }
  if (!draft.is_template) {
    return {
      ok: false,
      draftName: sourceDraftName,
      reason: `Source draft "${sourceDraftName}" is not flagged as a template — bubble-up disabled.`,
    };
  }
  if (!draft.exportConfig) {
    return {
      ok: false,
      draftName: sourceDraftName,
      reason: `Source draft "${sourceDraftName}" has no programmatic exportConfig — re-save the draft from the form to migrate it.`,
    };
  }

  const result = applyToDraft(proposed, draft.exportConfig);
  if (!result.ok) {
    return { ok: false, draftName: sourceDraftName, reason: result.error };
  }

  const wrote = await updateDraftExportConfig(sourceDraftName, result.next);
  if (!wrote) {
    return {
      ok: false,
      draftName: sourceDraftName,
      reason: "Draft update raced with another writer — bubble-up skipped.",
    };
  }
  return { ok: true, draftName: sourceDraftName, description: result.description };
}

// ── Reject ──────────────────────────────────────────────────────────────────

suggestionsRouter.post(
  "/suggestions/:id/reject",
  requireFeature("transcript_review", "write"),
  async (req, res) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid suggestion id" });
      return;
    }
    const suggestion = await getSuggestion(id);
    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    if (suggestion.status !== "pending") {
      res.status(409).json({ error: `Suggestion already ${suggestion.status}` });
      return;
    }
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : undefined;

    const updated = await updateSuggestion(id, {
      status: "rejected",
      decided_by: req.user?.username,
      decision_note: note,
    });
    await logAudit(req, "reject_transcript_suggestion", suggestion.client_slug, {
      suggestionId: id,
      type: suggestion.type,
      note,
    });
    res.json({ success: true, suggestion: updated });
  },
);

// ── Rollback ────────────────────────────────────────────────────────────────
//
// Restores the agent to the state immediately before this suggestion was
// applied. Same trust level as approve: an applied change is a publish, so
// undoing one is also a publish — gated by transcript_review:write.
//
// Mechanics: applied_version_id points at the post-apply snapshot. We look
// up the version *before* it (getPreviousVersion) and delegate to the
// existing node-editor rollback path. The suggestion itself flips to
// status="rolled_back" so the dashboard can hide it from the applied list
// and a future analyzer can use the rollback as a negative training signal.

suggestionsRouter.post(
  "/suggestions/:id/rollback",
  requireFeature("transcript_review", "write"),
  async (req, res) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid suggestion id" });
      return;
    }
    const suggestion = await getSuggestion(id);
    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    if (suggestion.status !== "applied") {
      res.status(409).json({
        error: `Only applied suggestions can be rolled back (got status=${suggestion.status})`,
      });
      return;
    }
    if (!suggestion.applied_version_id) {
      // Advisory approvals don't create a version snapshot, so they can't be
      // rolled back this way — operator has to undo the manual edit by hand.
      res.status(400).json({
        error: "Suggestion has no applied_version_id (likely advisory) — nothing to roll back to",
      });
      return;
    }

    const previous = await getPreviousVersion(suggestion.applied_version_id);
    if (!previous) {
      res.status(400).json({
        error:
          "No prior version found — applied snapshot may be the very first one, "
          + "or the prior snapshot was pruned by the 90-day TTL",
      });
      return;
    }

    // Delegate to the node-editor rollback handler (captured-response
    // proxy, same shape as approve uses for save-and-publish). Failures
    // there bubble back as the captured status; the suggestion stays
    // "applied" so the operator can retry.
    const captured: { status: number; body: unknown } = { status: 200, body: undefined };
    const proxyRes = makeCapturedResponse(captured);
    const proxyReq = req as unknown as Request & {
      params: Record<string, string>;
      body: Record<string, unknown>;
    };
    proxyReq.params = { slug: suggestion.client_slug, agentId: suggestion.agent_id };
    proxyReq.body = { versionId: previous._id.toString() };

    try {
      await rollbackToVersionHandler(
        proxyReq as Parameters<typeof rollbackToVersionHandler>[0],
        proxyRes,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: `rollback threw: ${msg}` });
      return;
    }

    if (captured.status >= 400) {
      res.status(captured.status).json(captured.body);
      return;
    }

    const note = typeof req.body?.note === "string" ? req.body.note.trim() : undefined;
    const updated = await updateSuggestion(id, {
      status: "rolled_back",
      rolled_back_at: new Date(),
      rolled_back_to_version_id: previous._id.toString(),
      decided_by: req.user?.username,
      decision_note: note || `Rolled back to version ${previous.version}`,
    });

    await logAudit(req, "rollback_transcript_suggestion", suggestion.client_slug, {
      suggestionId: id,
      type: suggestion.type,
      applied_version_id: suggestion.applied_version_id,
      rolled_back_to_version_id: previous._id.toString(),
      restored_version: previous.version,
    });

    res.json({
      success: true,
      suggestion: updated,
      restored_version: previous.version,
      restored_version_id: previous._id.toString(),
    });
  },
);

// ── Manual analyze (backfill / on-demand) ───────────────────────────────────
//
// Runs the analyzer on a specific completed call regardless of the agent's
// transcript_review_enabled flag. Operator-driven; gated by the same write
// permission as approvals. The post-hook orchestrator only fires on new
// calls, so this is the path for re-analyzing or for the initial backfill
// when an agent first opts in.

suggestionsRouter.post(
  "/agents/:slug/calls/:callId/analyze",
  requireFeature("transcript_review", "write"),
  async (req, res) => {
    const slug = String(req.params.slug);
    const callId = String(req.params.callId);

    const clientDoc = await getClientDocument(slug);
    if (!clientDoc) {
      res.status(404).json({ error: `Client "${slug}" not found` });
      return;
    }
    if (!clientDoc.agent_id) {
      res.status(400).json({ error: `Client "${slug}" has no agent_id` });
      return;
    }

    // Fetch the full call from Retell so we get the transcript +
    // transcript_object. The locally-cached call_logs row may not have the
    // transcript yet (it's populated async by owner-monitor) and we don't
    // want to fail-open on stale data.
    let retellCall: Record<string, unknown>;
    try {
      const retell = new Retell({ apiKey: config.RETELL_API_KEY });
      retellCall = (await retell.call.retrieve(callId)) as unknown as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      res.status(502).json({ error: `Failed to fetch call from Retell: ${msg}` });
      return;
    }

    const result = await analyzeAndPersist({
      callId,
      agentId: clientDoc.agent_id,
      clientSlug: slug,
      sourceDraft: clientDoc.source_draft,
      canonicalJson: clientDoc.retell_agents?.[clientDoc.agent_id],
      call: {
        call_id: callId,
        transcript: retellCall.transcript as string | undefined,
        transcript_object: retellCall.transcript_object as Array<Record<string, unknown>> | undefined,
        collected_dynamic_variables: retellCall.collected_dynamic_variables as Record<string, unknown> | undefined,
        retell_llm_dynamic_variables: retellCall.retell_llm_dynamic_variables as Record<string, unknown> | undefined,
        disconnection_reason: retellCall.disconnection_reason as string | undefined,
        duration_ms: retellCall.duration_ms as number | undefined,
      },
    });

    if (!result.ok) {
      res.status(500).json({ error: result.error });
      return;
    }

    await logAudit(req, "manual_analyze_call", slug, {
      callId,
      suggestionsCreated: result.suggestionsCreated,
    });

    res.json({
      success: true,
      suggestions_created: result.suggestionsCreated,
      suggestion_ids: result.suggestionIds,
    });
  },
);

// ── Edit-and-approve ────────────────────────────────────────────────────────
//
// Operator can tweak the proposed_change.payload before approving. Sends a
// patched proposed_change in the request body; this handler validates the
// shape minimally, persists it onto the suggestion, then forwards to the
// approve handler (so we don't fork the publish logic).

suggestionsRouter.post(
  "/suggestions/:id/edit",
  requireFeature("transcript_review", "write"),
  async (req, res) => {
    const id = String(req.params.id);
    if (!ObjectId.isValid(id)) {
      res.status(400).json({ error: "Invalid suggestion id" });
      return;
    }
    const suggestion = await getSuggestion(id);
    if (!suggestion) {
      res.status(404).json({ error: "Suggestion not found" });
      return;
    }
    if (suggestion.status !== "pending") {
      res.status(409).json({ error: `Suggestion already ${suggestion.status}` });
      return;
    }
    const next = req.body?.proposed_change;
    if (!next || typeof next !== "object") {
      res.status(400).json({ error: "proposed_change object is required" });
      return;
    }
    // Lock the kind — the operator can edit payload + diff_preview but not
    // change the type of remediation. Switching kinds is reject + new
    // suggestion territory.
    if (next.kind && next.kind !== suggestion.proposed_change.kind) {
      res.status(400).json({ error: "Cannot change proposed_change.kind via edit" });
      return;
    }

    const merged = {
      ...suggestion.proposed_change,
      ...next,
      kind: suggestion.proposed_change.kind,
    };
    await updateSuggestion(id, { proposed_change: merged });
    await logAudit(req, "edit_transcript_suggestion", suggestion.client_slug, {
      suggestionId: id,
      type: suggestion.type,
    });
    res.json({ success: true });
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseStatus(raw: unknown): import("../../lib/improvement-suggestions.js").SuggestionStatus | undefined {
  if (typeof raw !== "string") return undefined;
  if (
    raw === "pending" || raw === "approved" || raw === "rejected"
    || raw === "applied" || raw === "rolled_back"
  ) {
    return raw;
  }
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

// Express-ish Response with just enough surface for saveAndPublishHandler:
// status() chains, json() captures, set() / setHeader() / send() are stubbed.
function makeCapturedResponse(out: { status: number; body: unknown }): Response {
  const stub: Partial<Response> & { _captured?: typeof out } = {};
  stub.status = (code: number) => {
    out.status = code;
    return stub as Response;
  };
  stub.json = (body: unknown) => {
    out.body = body;
    return stub as Response;
  };
  stub.send = (body: unknown) => {
    out.body = body;
    return stub as Response;
  };
  stub.set = () => stub as Response;
  stub.setHeader = () => stub as Response;
  stub.type = () => stub as Response;
  return stub as Response;
}
