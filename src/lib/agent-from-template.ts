import { getDb } from "./db.js";
import type { CreateAgentBody } from "./agent-from-config.js";

export interface TemplateDoc {
  _id: unknown;
  name: string;
  type: "template";
  formData: Record<string, unknown>;
  exportConfig?: CreateAgentBody;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface FromTemplateOverrides {
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

export async function loadTemplate(name: string): Promise<TemplateDoc | null> {
  const doc = await getDb()
    .collection("agent_drafts")
    .find({ type: "template", name })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  return (doc as TemplateDoc | null) ?? null;
}

export function applyOverrides(
  exportConfig: CreateAgentBody,
  overrides: FromTemplateOverrides,
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
      // Pin client.name to the new businessName so the template's stored
      // client.name can never leak into a fresh agent. Explicit
      // overrides.client.name still wins because the spread above runs first.
      name: overrides.client?.name ?? overrides.business.businessName,
      slug,
    },
  };
}
