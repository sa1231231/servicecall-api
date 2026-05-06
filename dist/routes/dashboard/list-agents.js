import { getAllClientDocuments } from "../../config/client-store.js";
import { getMtdCogsForAllClients } from "../../lib/billing-cogs.js";
export async function listAgentsHandler(_req, res) {
    const docs = await getAllClientDocuments();
    const mtdBySlug = await getMtdCogsForAllClients().catch((err) => {
        console.error("[list-agents] MTD COGS aggregation failed:", err.message);
        return {};
    });
    const summaries = docs.map((doc) => ({
        slug: doc._id,
        name: doc.name,
        display_name: doc.display_name ?? null,
        shadow_mode: doc.shadow_mode ?? false,
        active: doc.active,
        agent_id: doc.agent_id,
        trial_start_date: doc.trial_start_date ?? null,
        mtd_cogs_cents: mtdBySlug[doc._id] ?? 0,
        folder_id: doc.folder_id ?? null,
        outbound_from_number: doc.outbound_from_number ?? null,
    }));
    res.json(summaries);
}
