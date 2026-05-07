import crypto from "crypto";
import { getDb } from "./db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PendingLeadStatus =
  | "queued"      // just created, enrichment hasn't started
  | "enriching"   // Anthropic call in flight
  | "ready"       // enriched, awaiting operator review
  | "failed"      // enrichment errored — operator can edit + promote anyway
  | "promoted"    // converted to a real Retell agent
  | "dismissed";  // operator soft-closed without promoting

export interface PendingLeadInput {
  /** Lead's display name as it appeared in the source (Sheet column or paste). */
  name: string;
  phone?: string;
  website?: string;
  /** Free-form context the operator paste-in or that came from the Sheet. */
  notes?: string;
}

export interface PendingLeadEnriched {
  business_name?: string;
  faqKnowledgeBase?: string;
  /** Suggested draft/template name from the skill (e.g. "hvac"). When set,
   *  the dashboard pre-selects the matching draft on the promote step. */
  templateName?: string;
  /** Forward-compat bag for fields the skill might add later
   *  (business_type, services, location, etc.). v0 doesn't surface these. */
  extra?: Record<string, unknown>;
}

export interface PendingLead {
  _id: string;
  source: "manual" | "sheet" | string;
  input: PendingLeadInput;
  status: PendingLeadStatus;
  enriched?: PendingLeadEnriched;
  enrichmentError?: string;
  /** Set when status==="promoted". The newly-created Retell agent's slug. */
  promotedSlug?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Collection ───────────────────────────────────────────────────────────────

function collection() {
  return getDb().collection<PendingLead>("pending_leads");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function newId(): string {
  // Hex string, URL-safe, 16 bytes — enough entropy for collision-free routing.
  return crypto.randomBytes(16).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Insert a fresh lead in `queued` status. Caller is expected to kick off
 *  enrichment async after this resolves. */
export async function createPendingLead(opts: {
  source: PendingLead["source"];
  input: PendingLeadInput;
}): Promise<PendingLead> {
  const lead: PendingLead = {
    _id: newId(),
    source: opts.source,
    input: opts.input,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await collection().insertOne(lead);
  return lead;
}

/** List leads, optionally filtered by status. Newest first. By default
 *  excludes terminal statuses (promoted/dismissed) so the queue is clean. */
export async function listPendingLeads(opts?: {
  status?: PendingLeadStatus;
  includeTerminal?: boolean;
}): Promise<PendingLead[]> {
  const query: Record<string, unknown> = {};
  if (opts?.status) {
    query.status = opts.status;
  } else if (!opts?.includeTerminal) {
    query.status = { $nin: ["promoted", "dismissed"] };
  }
  return collection().find(query).sort({ createdAt: -1 }).toArray();
}

export async function getPendingLead(id: string): Promise<PendingLead | null> {
  return collection().findOne({ _id: id } as any);
}

/** Apply field updates and bump updatedAt. Returns the updated doc. */
export async function updatePendingLead(
  id: string,
  updates: Partial<Pick<PendingLead, "input" | "status" | "enriched" | "enrichmentError" | "promotedSlug">>,
): Promise<PendingLead | null> {
  const setObj: Record<string, unknown> = { ...updates, updatedAt: nowIso() };
  await collection().updateOne({ _id: id } as any, { $set: setObj });
  return getPendingLead(id);
}

/** Convenience: mark a lead as promoted and stamp the resulting agent slug. */
export async function markPromoted(id: string, slug: string): Promise<void> {
  await collection().updateOne(
    { _id: id } as any,
    { $set: { status: "promoted", promotedSlug: slug, updatedAt: nowIso() } },
  );
}

export async function markDismissed(id: string): Promise<void> {
  await collection().updateOne(
    { _id: id } as any,
    { $set: { status: "dismissed", updatedAt: nowIso() } },
  );
}
