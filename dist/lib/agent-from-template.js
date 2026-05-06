import { getDb } from "./db.js";
export function slugify(input) {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}
export async function loadTemplate(name) {
    const doc = await getDb()
        .collection("agent_drafts")
        .find({ type: "template", name })
        .sort({ updatedAt: -1 })
        .limit(1)
        .next();
    return doc ?? null;
}
export function applyOverrides(exportConfig, overrides) {
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
            slug,
        },
    };
}
