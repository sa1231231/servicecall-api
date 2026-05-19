import {
  createPendingLead,
  findPendingLeadByExternalId,
  getPendingLead,
  updatePendingLead,
  type PendingLead,
  type PendingLeadInput,
} from "./pending-leads.js";
import { enrichLead } from "./enrich-lead.js";

/**
 * Run the Anthropic enrichment for a lead, then patch its status + enriched
 * fields (or its enrichmentError on failure). Best-effort — callers don't
 * await this so intake returns immediately. Errors are surfaced to the
 * operator via the lead's `enrichmentError` field, not thrown.
 *
 * Shared by the HTTP intake route and the Google Sheet poll job
 * (`leads-sheet-sync.ts`) so both ingest paths enrich identically.
 */
export async function runEnrichment(leadId: string, input: PendingLeadInput): Promise<void> {
  // Clear the prior error when we restart so the UI doesn't show a stale
  // failure while the new attempt is in flight.
  await updatePendingLead(leadId, { status: "enriching", enrichmentError: undefined });
  const result = await enrichLead(input);
  // Re-check the lead's status before patching back: enrichLead is a
  // multi-second LLM round-trip, and the operator (or an automated
  // teardown) may have dismissed or promoted the lead while we were
  // waiting. Overwriting a dismissed/promoted status with `ready`/`failed`
  // would resurrect a closed lead.
  const current = await getPendingLead(leadId);
  if (!current || current.status === "dismissed" || current.status === "promoted") {
    console.log(`[leads] enrichment finished for ${leadId} but lead is ${current?.status ?? "missing"}; skipping patch.`);
    return;
  }
  // Both branches stash the AI conversation under enriched.extra so the
  // dashboard's AI Feed panel can render what we sent and what came back,
  // regardless of parse outcome. The success branch overwrites with fresh
  // structured data; the failure branch merges into prior enriched fields
  // so a failed re-enrich doesn't wipe operator edits.
  const aiTrace = {
    _systemPrompt: result.systemPrompt,
    _userMessage: result.userMessage,
    _rawResponse: result.rawResponse,
    _rawContentBlocks: result.rawContentBlocks,
  };
  if (result.ok) {
    await updatePendingLead(leadId, {
      status: "ready",
      enriched: {
        business_name: result.business_name,
        faqKnowledgeBase: result.faqKnowledgeBase,
        templateName: result.templateName,
        website: result.website,
        city: result.city,
        state: result.state,
        email: result.email,
        extra: { ...result.extra, ...aiTrace },
      },
      enrichmentError: undefined,
    });
  } else {
    const merged = {
      ...(current.enriched ?? {}),
      extra: {
        ...(current.enriched?.extra ?? {}),
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

export interface IngestResult {
  lead: PendingLead;
  /** True when the lead already existed (matched by externalId) and no new
   *  doc was created — the caller should treat this as a no-op success. */
  deduped: boolean;
}

/**
 * Ingest one lead: dedup by externalId, create the pending-lead doc, and kick
 * off enrichment in the background. Single source of truth shared by the HTTP
 * intake route and the Sheet poll job.
 *
 * Idempotent on `externalId`: a second ingest with the same id returns the
 * existing lead instead of creating a duplicate. The unique sparse index on
 * `externalId` also closes the check-then-create race — if a concurrent
 * ingest (e.g. the Apps Script and the poll job touching the same row) wins
 * between our lookup and insert, Mongo throws 11000 and we re-resolve to the
 * winner.
 */
export async function ingestLead(opts: {
  source: string;
  input: PendingLeadInput;
  externalId?: string;
}): Promise<IngestResult> {
  if (opts.externalId) {
    const existing = await findPendingLeadByExternalId(opts.externalId);
    if (existing) return { lead: existing, deduped: true };
  }

  let lead: PendingLead;
  try {
    lead = await createPendingLead({
      source: opts.source,
      input: opts.input,
      externalId: opts.externalId,
    });
  } catch (err: any) {
    // Lost the unique-index race — another ingest created the doc first.
    if (err?.code === 11000 && opts.externalId) {
      const existing = await findPendingLeadByExternalId(opts.externalId);
      if (existing) return { lead: existing, deduped: true };
    }
    throw err;
  }

  // Fire-and-forget — callers surface status via GET /api/leads/:id.
  runEnrichment(lead._id, opts.input).catch((err) => {
    console.error(`[leads] enrichment crashed for ${lead._id}:`, err);
  });
  return { lead, deduped: false };
}
