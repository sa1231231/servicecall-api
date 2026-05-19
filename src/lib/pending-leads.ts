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
  /** Self-reported industry/category from a structured form question
   *  (e.g. Meta Lead Ads "which best fits the business you have?").
   *  Surfaced to the enrichment skill as a disambiguation hint. */
  business_type?: string;
}

export interface PendingLeadEnriched {
  business_name?: string;
  faqKnowledgeBase?: string;
  /** Suggested draft/template name from the skill (e.g. "hvac"). When set,
   *  the dashboard pre-selects the matching draft on the promote step. */
  templateName?: string;
  /** Structured business facts the skill resolved. Carried onto the promoted
   *  agent's contact/billing fields (website/city/state → contact_notes,
   *  email → contact_email). Any may be absent when unconfirmed. */
  website?: string;
  city?: string;
  state?: string;
  email?: string;
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
  /** Stable upstream id (e.g. Meta Lead Ads `l:...`) used for idempotent
   *  intake. When set, a second POST with the same externalId returns the
   *  existing lead instead of creating a duplicate. */
  externalId?: string;
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
  externalId?: string;
  status?: PendingLeadStatus;
}): Promise<PendingLead> {
  const lead: PendingLead = {
    _id: newId(),
    source: opts.source,
    input: opts.input,
    status: opts.status ?? "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (opts.externalId) lead.externalId = opts.externalId;
  await collection().insertOne(lead);
  return lead;
}

/** Lookup by upstream id (e.g. Meta Lead Ads `l:...`). Returns null if
 *  unknown. Used by the intake route to make Apps Script POSTs idempotent
 *  when the source sheet has no STATUS column to write back into. */
export async function findPendingLeadByExternalId(
  externalId: string,
): Promise<PendingLead | null> {
  return collection().findOne({ externalId } as any);
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
  updates: Partial<Pick<PendingLead, "input" | "status" | "enriched" | "enrichmentError" | "promotedSlug" | "externalId">>,
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

/**
 * Reset any lead that's been stuck in `enriching` longer than `staleAfterMs`
 * back to `failed`. Covers the case where a Railway redeploy (or any other
 * worker death) killed the process mid-`runEnrichment`, leaving the lead's
 * status stale forever — the route's success/failure patch never ran, so
 * nothing else clears it.
 *
 * Runs once on server boot. The threshold is conservative (default 3
 * minutes) so a still-in-flight enrichment can't be killed by a peer
 * replica's startup. Normal enrichments take 30–60s; the request-level
 * timeout in `enrichLead` is 120s. Anything >180s is definitionally dead.
 */
export async function resetStaleEnrichingLeads(staleAfterMs = 180_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const result = await collection().updateMany(
    { status: "enriching", updatedAt: { $lt: cutoff } } as any,
    {
      $set: {
        status: "failed",
        enrichmentError:
          "Worker died mid-enrichment (likely a redeploy or hang). Reset on server boot — click Re-enrich to retry.",
        updatedAt: nowIso(),
      },
    },
  );
  if (result.modifiedCount > 0) {
    console.log(`[pending-leads] reset ${result.modifiedCount} stale enriching lead(s) to failed`);
  }
  return result.modifiedCount;
}

// ── Indexes ──────────────────────────────────────────────────────────────────

/** Unique sparse index on externalId — only docs with externalId set are
 *  indexed, and the index enforces uniqueness so two concurrent intake
 *  POSTs with the same externalId can't both create a doc. */
export async function ensurePendingLeadIndexes(): Promise<void> {
  await collection().createIndex(
    { externalId: 1 },
    { unique: true, sparse: true, name: "externalId_unique_sparse" },
  );
  console.log("[pending-leads] indexes ensured");
}
