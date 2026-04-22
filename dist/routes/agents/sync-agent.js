import Retell from "retell-sdk";
import { config } from "../../config.js";
import { notificationClients } from "../../_cache/clients.js";
import { persistClient, getClientDocument, } from "../../config/client-store.js";
import { deriveNotificationConfig, } from "../../lib/notification-config.js";
import { fetchRetellAgent, extractFlowParams, extractAgentParams, } from "../../lib/retell-sync.js";
export async function importAgentHandler(req, res) {
    const body = req.body;
    // Validate
    if (!body.agent_id) {
        res.status(400).json({ error: "Missing required field: agent_id" });
        return;
    }
    if (!body.client?.slug) {
        res.status(400).json({ error: "Missing required field: client.slug" });
        return;
    }
    if (!Array.isArray(body.client.dispatch_text_numbers) || body.client.dispatch_text_numbers.length === 0) {
        res.status(400).json({ error: "Missing required field: client.dispatch_text_numbers (non-empty array)" });
        return;
    }
    if (notificationClients[body.client.slug]) {
        res.status(409).json({ error: `Client slug "${body.client.slug}" already exists` });
        return;
    }
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    try {
        console.log(`[import-agent] fetching agent ${body.agent_id} from Retell...`);
        const snapshot = await fetchRetellAgent(retell, body.agent_id);
        const jsonEntry = deriveNotificationConfig(snapshot.variables, body.client, snapshot.agentId);
        jsonEntry.retell_agents = { [snapshot.agentId]: snapshot.canonicalJson };
        const slug = body.client.slug;
        await persistClient(slug, jsonEntry);
        console.log(`[import-agent] client "${slug}" imported with agent ${snapshot.agentId}`);
        res.status(201).json({
            success: true,
            agent_id: snapshot.agentId,
            agent_name: snapshot.agentName,
            conversation_flow_id: snapshot.conversationFlowId,
            variables: snapshot.variables,
            notification_config: jsonEntry,
        });
    }
    catch (err) {
        console.error("[import-agent] error:", err);
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(502).json({ error: "Failed to import agent from Retell", details: message });
    }
}
// ── POST /agents/:slug/sync ─────────────────────────────────────────────────
export async function syncAgentHandler(req, res) {
    const slug = req.params.slug;
    const existingDoc = await getClientDocument(slug);
    if (!existingDoc) {
        res.status(404).json({ error: `Client "${slug}" not found` });
        return;
    }
    // Allow specifying which agent_id to sync via query param, default to first
    const rawAgentId = req.query.agent_id;
    const agentId = (typeof rawAgentId === "string" ? rawAgentId : undefined) ||
        existingDoc.agent_ids?.[0];
    if (!agentId) {
        res.status(400).json({ error: "No agent_id found for this client" });
        return;
    }
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    try {
        console.log(`[sync-agent] fetching agent ${agentId} from Retell for "${slug}"...`);
        const snapshot = await fetchRetellAgent(retell, agentId);
        // Derive new notification config, preserving existing dispatch info
        const clientInfo = {
            slug,
            name: existingDoc.name,
            dispatch_text_numbers: existingDoc.dispatch_text_numbers,
            dispatch_call_number: existingDoc.dispatch_call_number,
            dispatch_email: existingDoc.dispatch_email,
            dispatch_cc: existingDoc.dispatch_cc,
            outbound_from_number: existingDoc.outbound_from_number,
            summary_agent_id: existingDoc.summary_agent_id,
            phone_fallback_to_caller: existingDoc.phone_fallback_to_caller,
            hide_not_mentioned: existingDoc.hide_not_mentioned,
            shadow_mode: existingDoc.shadow_mode,
        };
        const jsonEntry = deriveNotificationConfig(snapshot.variables, clientInfo, agentId);
        // Preserve full agent_ids array from existing doc
        jsonEntry.agent_ids = existingDoc.agent_ids;
        // Merge canonical JSON: overwrite by agent_id
        jsonEntry.retell_agents = {
            ...(existingDoc.retell_agents ?? {}),
            [agentId]: snapshot.canonicalJson,
        };
        await persistClient(slug, jsonEntry);
        console.log(`[sync-agent] client "${slug}" synced from Retell agent ${agentId}`);
        res.status(200).json({
            success: true,
            agent_id: agentId,
            agent_name: snapshot.agentName,
            variables: snapshot.variables,
            notification_config: jsonEntry,
        });
    }
    catch (err) {
        console.error("[sync-agent] error:", err);
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(502).json({ error: "Failed to sync agent from Retell", details: message });
    }
}
export async function duplicateAgentHandler(req, res) {
    const body = req.body;
    // Validate
    if (!body.source_agent_id) {
        res.status(400).json({ error: "Missing required field: source_agent_id" });
        return;
    }
    if (!body.client?.slug) {
        res.status(400).json({ error: "Missing required field: client.slug" });
        return;
    }
    if (!Array.isArray(body.client.dispatch_text_numbers) || body.client.dispatch_text_numbers.length === 0) {
        res.status(400).json({ error: "Missing required field: client.dispatch_text_numbers (non-empty array)" });
        return;
    }
    if (notificationClients[body.client.slug]) {
        res.status(409).json({ error: `Client slug "${body.client.slug}" already exists` });
        return;
    }
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    let newFlowId;
    try {
        console.log(`[duplicate-agent] fetching source agent ${body.source_agent_id} from Retell...`);
        const snapshot = await fetchRetellAgent(retell, body.source_agent_id);
        // 1. Create new conversation flow (copy of source)
        const flowParams = extractFlowParams(snapshot.canonicalJson.conversationFlow);
        console.log(`[duplicate-agent] creating new conversation flow...`);
        const flowResponse = await retell.conversationFlow.create(flowParams);
        newFlowId = flowResponse.conversation_flow_id;
        console.log(`[duplicate-agent] flow created: ${newFlowId}`);
        // 2. Create new agent (copy of source, linked to new flow)
        const agentParams = extractAgentParams(snapshot.canonicalJson, newFlowId);
        // Override name if provided
        if (body.client.name) {
            agentParams.agent_name = body.client.name;
        }
        console.log(`[duplicate-agent] creating new agent...`);
        const agentResponse = await retell.agent.create(agentParams);
        const newAgentId = agentResponse.agent_id;
        console.log(`[duplicate-agent] agent created: ${newAgentId}`);
        // 3. Build canonical JSON for the new agent
        const newCanonicalJson = {
            ...snapshot.canonicalJson,
            agent_id: newAgentId,
            agent_name: body.client.name ?? snapshot.agentName,
        };
        // Update the nested flow reference
        const newFlowObj = flowResponse;
        newCanonicalJson.conversationFlow = newFlowObj;
        // 4. Derive notification config and persist
        const jsonEntry = deriveNotificationConfig(snapshot.variables, body.client, newAgentId);
        jsonEntry.retell_agents = { [newAgentId]: newCanonicalJson };
        const slug = body.client.slug;
        await persistClient(slug, jsonEntry);
        console.log(`[duplicate-agent] client "${slug}" created with agent ${newAgentId}`);
        res.status(201).json({
            success: true,
            agent_id: newAgentId,
            conversation_flow_id: newFlowId,
            source_agent_id: body.source_agent_id,
            variables: snapshot.variables,
            notification_config: jsonEntry,
        });
    }
    catch (err) {
        console.error("[duplicate-agent] error:", err);
        // Cleanup: if we created a flow but agent creation failed
        if (newFlowId) {
            try {
                console.log(`[duplicate-agent] cleaning up flow ${newFlowId}`);
                await retell.conversationFlow.delete(newFlowId);
            }
            catch (cleanupErr) {
                console.error("[duplicate-agent] cleanup failed:", cleanupErr);
            }
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(502).json({ error: "Failed to duplicate agent in Retell", details: message });
    }
}
