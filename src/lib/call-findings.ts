// Per-(call, finding) rows produced by the transcript analyzer. One call
// can produce zero, one, or many findings. Findings feed into
// `improvement_suggestions` 1:1 in Phase 1; Phase 2 will aggregate them.
//
// TTL 90 days — long enough to debug a Phase 2 aggregation, short enough
// that the AI trace (which contains transcript excerpts) doesn't accumulate
// indefinitely.

import { ObjectId, type WithId } from "mongodb";
import { getDb } from "./db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type FindingType =
  | "unanswered_question"
  | "misheard_confirmation"
  | "repeated_data"
  | "frustration_signal"
  | "premature_termination"
  | "path_misroute";

export type FindingSeverity = "low" | "medium" | "high";

export type ProposedChangeKind =
  | "add_faq_entry"
  | "edit_collect_prompt"
  | "add_finetune_example"
  | "edit_close_transition"
  | "edit_router_branch"
  | "split_data_point";

export interface ProposedChange {
  kind: ProposedChangeKind;
  /** Node id when the change targets a specific node. */
  target_node_id?: string;
  /** Path name when the change targets a specific path (close prompts, router edges). */
  target_path_name?: string;
  /** Variable name when the change targets a specific data point (collect prompt, finetune). */
  target_variable_name?: string;
  /** Shape varies per kind; the suggestion-applier knows how to translate. */
  payload: Record<string, unknown>;
  diff_preview: { before: string; after: string };
}

export interface CallFindingDoc {
  call_id: string;
  agent_id: string;
  client_slug: string;
  /** Set when the source agent was created from a draft (for Phase 3 propagation). */
  source_draft?: string;
  type: FindingType;
  severity: FindingSeverity;
  transcript_span: { start_ms?: number; end_ms?: number; excerpt: string };
  description: string;
  proposed_change: ProposedChange;
  created_at: Date;
  /** Raw analyzer trace — kept for debugging only. */
  ai_trace: { systemPrompt: string; userMessage: string; rawContentBlocks: string };
}

const COLLECTION = "call_findings";
const TTL_DAYS = 90;

function col() {
  return getDb().collection<CallFindingDoc>(COLLECTION);
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function insertFindings(
  findings: CallFindingDoc[],
): Promise<WithId<CallFindingDoc>[]> {
  if (findings.length === 0) return [];
  const result = await col().insertMany(findings);
  return findings.map((f, i) => ({ ...f, _id: result.insertedIds[i] }));
}

export async function getFinding(id: string): Promise<WithId<CallFindingDoc> | null> {
  if (!ObjectId.isValid(id)) return null;
  return col().findOne({ _id: new ObjectId(id) });
}

export async function listFindingsForCall(
  callId: string,
): Promise<WithId<CallFindingDoc>[]> {
  return col().find({ call_id: callId }).toArray();
}

// ── Indexes ──────────────────────────────────────────────────────────────────

export async function ensureCallFindingIndexes(): Promise<void> {
  await col().createIndex({ call_id: 1 });
  await col().createIndex({ agent_id: 1, created_at: -1 });
  await col().createIndex(
    { created_at: 1 },
    { expireAfterSeconds: TTL_DAYS * 86400 },
  );
  console.log("[call-findings] indexes ensured");
}
