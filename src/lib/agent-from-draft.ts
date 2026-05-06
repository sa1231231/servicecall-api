import { getDb } from "./db.js";
import type { CreateAgentBody } from "./agent-from-config.js";

export interface DraftDoc {
  _id: unknown;
  name: string;
  formData: Record<string, unknown>;
  exportConfig?: CreateAgentBody;
  createdAt?: Date;
  updatedAt?: Date;
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
