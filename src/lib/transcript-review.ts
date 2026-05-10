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

export async function runTranscriptReview(input: TranscriptReviewInput): Promise<void> {
  const { callId, agentId, call, isShadowOrTest } = input;

  if (isShadowOrTest) {
    console.log(`[transcript-review] skipping ${callId} (shadow or test mode)`);
    return;
  }

  const clientSlug = agentIdToSlug[agentId];
  if (!clientSlug) {
    // No client config means notifications already short-circuited;
    // there's nothing to suggest fixes for.
    return;
  }
  // Read the full client doc so we get fields not held in the in-memory
  // ClientNotificationConfig cache (transcript_review_enabled, source_draft,
  // retell_agents). Adds one Mongo read per analyzed call — cheap relative
  // to the Anthropic round-trip we're about to make.
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

  // Build agent context from the canonical JSON. Best-effort: if the parse
  // fails we still run the analyzer, just without targeting node ids.
  let agentContext: string | undefined;
  try {
    const canonical = clientDoc.retell_agents?.[agentId];
    if (canonical) {
      const parsed = parseConversationFlow(canonical);
      agentContext = buildAgentContext(parsed);
    }
  } catch (err) {
    console.warn(`[transcript-review] could not parse canonical for ${agentId}:`, err);
  }

  const analyzerResult = await analyzeTranscript({
    callId,
    agentId,
    clientSlug,
    sourceDraft: clientDoc.source_draft,
    transcript,
    transcriptObject: call.transcript_object,
    collectedVars: call.collected_dynamic_variables ?? {},
    dynamicVars: call.retell_llm_dynamic_variables ?? {},
    disconnectionReason: call.disconnection_reason ?? "unknown",
    durationMs,
    agentContext,
  });

  if (!analyzerResult.ok) {
    console.warn(`[transcript-review] analyzer failed for ${callId}: ${analyzerResult.error}`);
    return;
  }

  if (analyzerResult.findings.length === 0) {
    console.log(`[transcript-review] ${callId} clean (no findings)`);
    return;
  }

  // Persist findings + 1:1 suggestions. Stamp the AI trace onto every
  // finding so the operator can audit what the model saw.
  const trace = analyzerResult.trace;
  const findingDocs: CallFindingDoc[] = analyzerResult.findings.map((f) => ({
    call_id: callId,
    agent_id: agentId,
    client_slug: clientSlug,
    source_draft: clientDoc.source_draft,
    type: f.type,
    severity: f.severity,
    transcript_span: f.transcript_span,
    description: f.description,
    proposed_change: f.proposed_change,
    created_at: new Date(),
    ai_trace: trace,
  }));

  const inserted = await insertFindings(findingDocs);

  for (const finding of inserted) {
    await createSuggestion({
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
  }

  console.log(`[transcript-review] ${callId} produced ${inserted.length} suggestion(s)`);
}
