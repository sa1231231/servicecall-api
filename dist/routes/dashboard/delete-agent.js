import Retell from "retell-sdk";
import { config } from "../../config.js";
import { getClientDocument, softDeleteClient, } from "../../config/client-store.js";
import { logAudit } from "../../lib/audit.js";
import { alertRootIfNeeded } from "../../lib/root-alerts.js";
const SOFT_DELETE_DAYS = 30;
/** Build the "[DELETED — expires YYYY-MM-DD]" suffix. */
function deletedSuffix() {
    const expires = new Date();
    expires.setDate(expires.getDate() + SOFT_DELETE_DAYS);
    return ` [DELETED — expires ${expires.toISOString().slice(0, 10)}]`;
}
/** Rename a Retell agent to mark it as soft-deleted. */
async function markRetellAgent(retell, agentId, warnings) {
    try {
        const agent = await retell.agent.retrieve(agentId);
        await retell.agent.update(agentId, {
            agent_name: (agent.agent_name ?? agentId) + deletedSuffix(),
        });
        console.log(`[delete-agent] renamed Retell agent ${agentId} as deleted`);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[delete-agent] could not rename Retell agent ${agentId}: ${msg}`);
        warnings.push(`Retell agent ${agentId}: ${msg}`);
    }
}
export async function deleteAgentHandler(req, res) {
    const slug = String(req.params.slug);
    const doc = await getClientDocument(slug);
    if (!doc) {
        res.status(404).json({ error: `Client "${slug}" not found` });
        return;
    }
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    const warnings = [];
    // Soft-delete: rename each Retell agent instead of deleting
    const retellAgents = doc.retell_agents ?? {};
    for (const agentId of Object.keys(retellAgents)) {
        await markRetellAgent(retell, agentId, warnings);
    }
    // Also handle any agent_ids not in retell_agents (belt-and-suspenders)
    for (const agentId of doc.agent_ids ?? []) {
        if (retellAgents[agentId])
            continue; // already handled above
        await markRetellAgent(retell, agentId, warnings);
    }
    // Soft-delete: mark as deleted but keep in MongoDB for 30-day recovery
    await softDeleteClient(slug);
    await logAudit(req, "delete_agent", slug);
    alertRootIfNeeded(req, "delete_agent", slug);
    res.json({ success: true, slug, warnings: warnings.length > 0 ? warnings : undefined });
}
