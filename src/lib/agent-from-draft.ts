import { getDb } from "./db.js";
import type { CreateAgentBody } from "./agent-from-config.js";

export interface DraftDoc {
  _id: unknown;
  name: string;
  formData: Record<string, unknown>;
  exportConfig?: CreateAgentBody;
  createdAt?: Date;
  updatedAt?: Date;
  // When true, agents created from this draft auto-inherit
  // transcript_review_enabled. Used to mark drafts that double as reusable
  // templates (e.g. the HVAC draft) so every agent built from one is
  // analyzed for failure patterns out of the box.
  is_template?: boolean;
}

export interface FromDraftOverrides {
  business: {
    businessName: string;
    faqKnowledgeBase: string;
  };
  client?: Partial<CreateAgentBody["client"]>;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Look up the most-recently-updated draft by name. The collection used to
// distinguish "drafts" and "templates" via a `type` field; that distinction
// has been collapsed — every saved form config is now just a draft.
export async function loadDraft(name: string): Promise<DraftDoc | null> {
  const doc = await getDb()
    .collection("agent_drafts")
    .find({ name })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  return (doc as DraftDoc | null) ?? null;
}

/**
 * Replace the exportConfig on the most-recently-updated draft with the given
 * name. Used by the transcript-suggestion bubble-up flow when an operator
 * approves a change with scope=agent_and_draft. Returns true when a doc was
 * matched and updated.
 */
export async function updateDraftExportConfig(
  name: string,
  exportConfig: CreateAgentBody,
): Promise<boolean> {
  const existing = await loadDraft(name);
  if (!existing || !existing._id) return false;
  const result = await getDb()
    .collection("agent_drafts")
    .updateOne(
      { _id: existing._id as any },
      { $set: { exportConfig, updatedAt: new Date() } },
    );
  return result.matchedCount > 0;
}

export function applyOverrides(
  exportConfig: CreateAgentBody,
  overrides: FromDraftOverrides,
): CreateAgentBody {
  const slug = overrides.client?.slug?.trim()
    || slugify(overrides.business.businessName);

  return {
    ...exportConfig,
    business: {
      ...exportConfig.business,
      businessName: overrides.business.businessName,
      faqKnowledgeBase: overrides.business.faqKnowledgeBase,
    },
    client: {
      ...exportConfig.client,
      ...(overrides.client ?? {}),
      // Pin client.name to the new businessName so the draft's stored
      // client.name can never leak into a fresh agent. Explicit
      // overrides.client.name still wins because the spread above runs first.
      name: overrides.client?.name ?? overrides.business.businessName,
      slug,
    },
  };
}
