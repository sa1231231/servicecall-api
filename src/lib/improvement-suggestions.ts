// Operator-facing improvement suggestions. Phase 1: one suggestion per
// finding (1:1). Phase 2 will aggregate findings into single suggestions
// keyed by pattern + agent — the schema is shaped for that future grouping
// already (`finding_ids` is an array even when length 1).

import { ObjectId, type WithId } from "mongodb";
import { getDb } from "./db.js";
import type {
  FindingType,
  FindingSeverity,
  ProposedChange,
} from "./call-findings.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SuggestionStatus = "pending" | "approved" | "rejected" | "applied" | "rolled_back";

export type SuggestionScope = "agent" | "draft";

export interface SuggestionDoc {
  agent_id: string;
  client_slug: string;
  finding_ids: ObjectId[];
  type: FindingType;
  severity: FindingSeverity;
  scope: SuggestionScope;
  /** agent_id when scope=agent, draft name when scope=draft. */
  scope_target: string;
  status: SuggestionStatus;
  proposed_change: ProposedChange;
  /** First-finding excerpt + description, for the dashboard card. */
  excerpt: string;
  description: string;
  created_at: Date;
  updated_at: Date;
  applied_at?: Date;
  /** ID of the agent_versions snapshot created when the change was published. */
  applied_version_id?: string;
  /** When this suggestion was rolled back (status="rolled_back"). */
  rolled_back_at?: Date;
  /** ID of the agent_versions snapshot we restored to. */
  rolled_back_to_version_id?: string;
  decided_by?: string;
  decision_note?: string;
}

const COLLECTION = "improvement_suggestions";

function col() {
  return getDb().collection<SuggestionDoc>(COLLECTION);
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function createSuggestion(
  doc: Omit<SuggestionDoc, "created_at" | "updated_at" | "status"> & {
    status?: SuggestionStatus;
  },
): Promise<WithId<SuggestionDoc>> {
  const now = new Date();
  const full: SuggestionDoc = {
    status: "pending",
    ...doc,
    created_at: now,
    updated_at: now,
  };
  const result = await col().insertOne(full);
  return { ...full, _id: result.insertedId };
}

export async function getSuggestion(
  id: string,
): Promise<WithId<SuggestionDoc> | null> {
  if (!ObjectId.isValid(id)) return null;
  return col().findOne({ _id: new ObjectId(id) });
}

export async function listSuggestions(opts: {
  agentId?: string;
  clientSlug?: string;
  status?: SuggestionStatus | SuggestionStatus[];
  limit?: number;
  offset?: number;
}): Promise<WithId<SuggestionDoc>[]> {
  const filter: Record<string, unknown> = {};
  if (opts.agentId) filter.agent_id = opts.agentId;
  if (opts.clientSlug) filter.client_slug = opts.clientSlug;
  if (opts.status) {
    filter.status = Array.isArray(opts.status) ? { $in: opts.status } : opts.status;
  }
  return col()
    .find(filter)
    .sort({ created_at: -1 })
    .skip(opts.offset ?? 0)
    .limit(opts.limit ?? 50)
    .toArray();
}

export async function updateSuggestion(
  id: string,
  updates: Partial<Omit<SuggestionDoc, "_id" | "created_at">>,
): Promise<WithId<SuggestionDoc> | null> {
  if (!ObjectId.isValid(id)) return null;
  const result = await col().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...updates, updated_at: new Date() } },
    { returnDocument: "after" },
  );
  return result ?? null;
}

export async function countPendingForAgent(agentId: string): Promise<number> {
  return col().countDocuments({ agent_id: agentId, status: "pending" });
}

// ── Indexes ──────────────────────────────────────────────────────────────────

export async function ensureSuggestionIndexes(): Promise<void> {
  await col().createIndex({ agent_id: 1, status: 1, created_at: -1 });
  await col().createIndex({ client_slug: 1, status: 1, created_at: -1 });
  await col().createIndex({ status: 1, created_at: -1 });
  console.log("[improvement-suggestions] indexes ensured");
}
