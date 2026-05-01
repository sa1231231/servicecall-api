import Retell from "retell-sdk";
import { config } from "../../config.js";
import { updateClientFields } from "../../config/client-store.js";
import { notificationClients } from "../../_cache/clients.js";
export async function toggleActiveHandler(req, res) {
    const slug = req.params.slug;
    const { active } = req.body;
    if (typeof active !== "boolean") {
        res.status(400).json({ error: "active must be a boolean" });
        return;
    }
    const client = notificationClients[slug];
    if (!client) {
        res.status(404).json({ error: `Client "${slug}" not found` });
        return;
    }
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    const allNumbers = await retell.phoneNumber.list();
    const clientAgentIds = new Set(client.agent_ids);
    let matchingNumbers;
    if (active) {
        // Re-activating: use the stored deactivated_numbers to find which numbers to re-bind
        const stored = client.deactivated_numbers;
        if (stored && stored.length > 0) {
            const storedSet = new Set(stored);
            matchingNumbers = allNumbers.filter((n) => storedSet.has(n.phone_number));
        }
        else {
            // Fallback: match by outbound_from_number
            matchingNumbers = allNumbers.filter((n) => client.outbound_from_number && n.phone_number === client.outbound_from_number);
        }
    }
    else {
        // Deactivating: find numbers that currently have this client's agent bound
        matchingNumbers = allNumbers.filter((n) => {
            if (n.inbound_agents?.some((a) => clientAgentIds.has(a.agent_id)))
                return true;
            if (n.inbound_agent_id && clientAgentIds.has(n.inbound_agent_id))
                return true;
            if (client.outbound_from_number && n.phone_number === client.outbound_from_number)
                return true;
            return false;
        });
    }
    if (matchingNumbers.length === 0) {
        console.log(`[toggle-active] no Retell phone numbers found for "${slug}"`);
    }
    // Update each matching phone number's inbound agent binding
    const errors = [];
    const updatedNumbers = [];
    for (const num of matchingNumbers) {
        try {
            if (active) {
                const agentId = client.agent_ids[0];
                if (agentId) {
                    await retell.phoneNumber.update(num.phone_number, {
                        inbound_agents: [{ agent_id: agentId, weight: 1 }],
                    });
                    console.log(`[toggle-active] enabled inbound agent on ${num.phone_number} → ${agentId}`);
                    updatedNumbers.push(num.phone_number);
                }
            }
            else {
                await retell.phoneNumber.update(num.phone_number, {
                    inbound_agent_id: null,
                    inbound_agents: null,
                });
                console.log(`[toggle-active] cleared inbound agents on ${num.phone_number}`);
                updatedNumbers.push(num.phone_number);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[toggle-active] failed to update ${num.phone_number}: ${msg}`);
            errors.push(`${num.phone_number}: ${msg}`);
        }
    }
    if (errors.length > 0) {
        res.status(500).json({ error: "Failed to update Retell phone numbers", details: errors });
        return;
    }
    // Persist active state + deactivated numbers in MongoDB
    try {
        const updates = { active };
        if (!active && updatedNumbers.length > 0) {
            // Remember which numbers we cleared so we can re-bind on reactivation
            updates.deactivated_numbers = updatedNumbers;
        }
        else if (active) {
            // Clear the stored list once re-activated
            updates.deactivated_numbers = null;
        }
        await updateClientFields(slug, updates);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(404).json({ error: message });
        return;
    }
    console.log(`[toggle-active] ${slug} is now ${active ? "ACTIVE" : "INACTIVE"} (${updatedNumbers.length} number(s) updated)`);
    res.json({ success: true, slug, active, numbers_updated: updatedNumbers.length });
}
