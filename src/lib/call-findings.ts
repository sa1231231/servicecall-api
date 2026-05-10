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

// Each kind targets exactly ONE component on ONE specific node. The
// component_kind in the diff_preview matches 1:1 with the kind so the
// dashboard can render an unambiguous "Editing {component} on {node}" header.
//
// Naming convention: <verb>_<node>_<component>
//   edit_*_prompt          → conversation prompt text
//   add_*_finetune         → append finetune example
//   edit_*_transition      → transition condition text on an edge
//
// Old kind names (`add_finetune_example`, `edit_close_transition`) are
// aliased to the new ones in the applier so existing suggestions in Mongo
// keep working.
export type ProposedChangeKind =
  // Agent-global
  | "edit_global_prompt"        // flow.global_prompt
  | "add_faq_entry"             // append to FAQ knowledge base node instruction.text
  // Intro node (greeting + path routing)
  | "edit_intro_prompt"         // intro node instruction.text
  | "edit_intro_transition"     // intro→path edge transition_condition.prompt
  | "add_intro_finetune"        // intro node finetune_transition_examples
  // Per-path Collect node (data point capture)
  | "edit_collect_prompt"       // Collect node instruction.text
  | "add_collect_finetune"      // Collect node finetune_transition_examples
  // Per-path Close node (callback paths only)
  | "edit_close_prompt"         // Close node instruction.text
  // Advisory only — not auto-applicable
  | "edit_router_branch"
  | "split_data_point"
  // Backwards-compatible aliases (existing suggestions in Mongo)
  | "add_finetune_example"      // → add_collect_finetune
  | "edit_close_transition";    // → edit_close_prompt

/** Which component on which node a `proposed_change` targets. Drives the UI's
 *  "Editing {component} on {node}" header so the operator never has to guess
 *  what the diff applies to. */
export type ComponentKind =
  | "global_prompt"
  | "faq_knowledge_base"
  | "conversation_prompt"
  | "transition_condition"
  | "finetune_examples";

export interface DiffPreview {
  /** Plain-English label for this kind of edit, e.g. "Conversation prompt". */
  component_kind: ComponentKind;
  /** Human-readable component label including the node, e.g.
   *  "Collect Phone Number — conversation prompt" or
   *  "Intro node — finetune examples (routes to FAQ)". */
  component_label: string;
  /** Just the node name, e.g. "Collect Phone Number" or "Intro". */
  node_label?: string;
  /** Full text or serialized list of the component BEFORE the change.
   *  For finetune examples this is the existing array, formatted as
   *  "[user]: …\n[agent]: …" blocks separated by blank lines. */
  before: string;
  /** Full text or serialized list AFTER applying the change. */
  after: string;
}

export interface ProposedChange {
  kind: ProposedChangeKind;
  /** Node id when the change targets a specific node. */
  target_node_id?: string;
  /** Path name when the change targets a specific path (close prompts, intro
   *  transitions, router edges). */
  target_path_name?: string;
  /** Variable name when the change targets a specific data point (collect
   *  prompt, collect finetune). */
  target_variable_name?: string;
  /** Shape varies per kind; the suggestion-applier knows how to translate. */
  payload: Record<string, unknown>;
  /** Computed by the suggestion-applier from the current parsed-flow snapshot
   *  at the moment the suggestion is created. The applier reads the actual
   *  current value of the targeted component to build a real before/after the
   *  operator can scan, instead of relying on the analyzer's guess. */
  diff_preview: DiffPreview;
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
