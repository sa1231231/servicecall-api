// Fire-and-forget orchestrator that runs after every completed call
// (when the client has opted in). Mirrors the runEnrichment() pattern in
// src/routes/leads/index.ts:
//
//   - Caller doesn't await; errors land in console.error, never bubble up
//   - State guards short-circuit before the expensive LLM call
//   - Result is best-effort: a crashed analyzer just leaves no findings,
//     it doesn't poison the call_logs row.

import { agentIdToSlug } from "../_cache/clients.js";
import { getClientDocument } from "../config/client-store.js";
import { analyzeTranscript, buildAgentContext } from "./transcript-analyzer.js";
import { insertFindings, type CallFindingDoc } from "./call-findings.js";
import { createSuggestion } from "./improvement-suggestions.js";
import { parseConversationFlow } from "./node-parser.js";

// ── Input ────────────────────────────────────────────────────────────────────

export interface TranscriptReviewInput {
  callId: string;
  agentId: string;
  /** Live Retell call payload from the post-hook — provides transcript,
   *  transcript_object, collected/dynamic vars, disconnection_reason, duration. */
  call: {
    call_id?: string;
    transcript?: string;
    transcript_object?: Array<Record<string, unknown>>;
    collected_dynamic_variables?: Record<string, unknown>;
    retell_llm_dynamic_variables?: Record<string, unknown>;
    disconnection_reason?: string;
    duration_ms?: number;
  };
  /** Set when the call was a shadow/test event; the orchestrator skips. */
  isShadowOrTest: boolean;
}

// ── Tunables ────────────────────────────────────────────────────────────────

const MIN_TRANSCRIPT_CHARS = 200;
const MIN_DURATION_MS = 15_000;

// ── Public API ──────────────────────────────────────────────────────────────

/** Post-hook orchestrator: runs all the precondition gates before invoking
 *  the analyzer. Skipped silently when the agent isn't opted in or the
 *  call is too short. Used as fire-and-forget from src/routes/retell/post-hook.ts. */
export async function runTranscriptReview(input: TranscriptReviewInput): Promise<void> {
  const { callId, agentId, call, isShadowOrTest } = input;

  if (isShadowOrTest) {
    console.log(`[transcript-review] skipping ${callId} (shadow or test mode)`);
    return;
  }

  const clientSlug = agentIdToSlug[agentId];
  if (!clientSlug) return;

  const clientDoc = await getClientDocument(clientSlug);
  if (!clientDoc) return;

  if (!clientDoc.transcript_review_enabled) {
    // Per-client opt-in. Default off keeps Anthropic spend bounded.
    return;
  }

  const transcript = (call.transcript ?? "").trim();
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    console.log(`[transcript-review] skipping ${callId} (transcript ${transcript.length} chars < ${MIN_TRANSCRIPT_CHARS})`);
    return;
  }

  const durationMs = call.duration_ms ?? 0;
  if (durationMs < MIN_DURATION_MS) {
    console.log(`[transcript-review] skipping ${callId} (duration ${durationMs}ms < ${MIN_DURATION_MS}ms)`);
    return;
  }

  const result = await analyzeAndPersist({
    callId,
    agentId,
    clientSlug,
    sourceDraft: clientDoc.source_draft,
    canonicalJson: clientDoc.retell_agents?.[agentId],
    call,
  });
  if (result.ok) {
    console.log(`[transcript-review] ${callId} produced ${result.suggestionsCreated} suggestion(s)`);
  } else {
    console.warn(`[transcript-review] analyzer failed for ${callId}: ${result.error}`);
  }
}

// ── Lower-level helper (manual-trigger entry point) ─────────────────────────

export interface AnalyzeAndPersistInput {
  callId: string;
  agentId: string;
  clientSlug: string;
  sourceDraft?: string;
  /** Canonical JSON for the agent, if available — used to build the
   *  per-node agent context the analyzer can target. */
  canonicalJson?: Record<string, unknown>;
  call: TranscriptReviewInput["call"];
}

export interface AnalyzeAndPersistSuccess {
  ok: true;
  suggestionsCreated: number;
  /** IDs of the suggestion documents created. */
  suggestionIds: string[];
}

export interface AnalyzeAndPersistFailure {
  ok: false;
  error: string;
}

export type AnalyzeAndPersistResult = AnalyzeAndPersistSuccess | AnalyzeAndPersistFailure;

/** Bypasses the orchestrator's precondition gates (opt-in, duration,
 *  transcript length). Used by the manual-trigger endpoint to backfill
 *  analysis on calls that completed before the operator opted in. */
export async function analyzeAndPersist(input: AnalyzeAndPersistInput): Promise<AnalyzeAndPersistResult> {
  const { callId, agentId, clientSlug, sourceDraft, canonicalJson, call } = input;

  const transcript = (call.transcript ?? "").trim();
  if (!transcript) return { ok: false, error: "Call has no transcript — cannot analyze." };

  let agentContext: string | undefined;
  if (canonicalJson) {
    try {
      const parsed = parseConversationFlow(canonicalJson);
      agentContext = buildAgentContext(parsed);
    } catch (err) {
      console.warn(`[transcript-review] could not parse canonical for ${agentId}:`, err);
    }
  }

  const analyzerResult = await analyzeTranscript({
    callId,
    agentId,
    clientSlug,
    sourceDraft,
    transcript,
    transcriptObject: call.transcript_object,
    collectedVars: call.collected_dynamic_variables ?? {},
    dynamicVars: call.retell_llm_dynamic_variables ?? {},
    disconnectionReason: call.disconnection_reason ?? "unknown",
    durationMs: call.duration_ms ?? 0,
    agentContext,
  });

  if (!analyzerResult.ok) {
    return { ok: false, error: analyzerResult.error };
  }

  if (analyzerResult.findings.length === 0) {
    return { ok: true, suggestionsCreated: 0, suggestionIds: [] };
  }

  const trace = analyzerResult.trace;
  const findingDocs: CallFindingDoc[] = analyzerResult.findings.map((f) => ({
    call_id: callId,
    agent_id: agentId,
    client_slug: clientSlug,
    source_draft: sourceDraft,
    type: f.type,
    severity: f.severity,
    transcript_span: f.transcript_span,
    description: f.description,
    proposed_change: f.proposed_change,
    created_at: new Date(),
    ai_trace: trace,
  }));

  const inserted = await insertFindings(findingDocs);
  const suggestionIds: string[] = [];
  for (const finding of inserted) {
    const sugg = await createSuggestion({
      agent_id: finding.agent_id,
      client_slug: finding.client_slug,
      finding_ids: [finding._id],
      type: finding.type,
      severity: finding.severity,
      scope: "agent",
      scope_target: finding.agent_id,
      proposed_change: finding.proposed_change,
      excerpt: finding.transcript_span.excerpt,
      description: finding.description,
    });
    suggestionIds.push(sugg._id.toString());
  }

  return { ok: true, suggestionsCreated: inserted.length, suggestionIds };
}
