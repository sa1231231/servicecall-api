import { getAllClientDocuments } from "../../config/client-store.js";
export async function listAgentsHandler(_req, res) {
    const docs = await getAllClientDocuments();
    const summaries = docs.map((doc) => ({
        slug: doc._id,
        name: doc.name,
        shadow_mode: doc.shadow_mode ?? false,
        active: doc.active,
        agent_ids: doc.agent_ids,
        trial_start_date: doc.trial_start_date ?? null,
    }));
    res.json(summaries);
}
