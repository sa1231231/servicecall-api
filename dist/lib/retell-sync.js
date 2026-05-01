import { toLabel } from "./notification-config.js";
import { INTERNAL_VARS } from "./agent-generator/data-point-registry.js";
// ── Strip keys for Retell SDK create calls ───────────────────────────────────
const AGENT_STRIP_KEYS = new Set([
    "agent_id",
    "channel",
    "last_modification_timestamp",
    "version",
    "is_published",
    "version_title",
    "conversationFlow",
    "response_engine",
]);
const FLOW_STRIP_KEYS = new Set([
    "conversation_flow_id",
    "version",
    "is_published",
    "flex_mode",
    "is_transfer_cf",
]);
export function extractFlowParams(conversationFlow) {
    const params = {};
    for (const [key, value] of Object.entries(conversationFlow)) {
        if (!FLOW_STRIP_KEYS.has(key)) {
            params[key] = value;
        }
    }
    return params;
}
export function extractAgentParams(agentJson, conversationFlowId) {
    const params = {};
    for (const [key, value] of Object.entries(agentJson)) {
        if (!AGENT_STRIP_KEYS.has(key)) {
            params[key] = value;
        }
    }
    params.response_engine = {
        type: "conversation-flow",
        conversation_flow_id: conversationFlowId,
    };
    return params;
}
export function extractVariables(canonicalJson) {
    const flow = canonicalJson.conversationFlow;
    if (!flow)
        return [];
    const nodes = flow.nodes;
    if (!Array.isArray(nodes))
        return [];
    // Try to find the "Extract All Variables" node first (has all vars)
    let extractNode = nodes.find((n) => n.type === "extract_dynamic_variables" &&
        n.name === "Extract All Variables");
    // Fallback: collect from all extract_dynamic_variables nodes
    if (!extractNode) {
        const allVars = [];
        const seen = new Set();
        for (const node of nodes) {
            if (node.type !== "extract_dynamic_variables")
                continue;
            const vars = node.variables;
            if (!Array.isArray(vars))
                continue;
            for (const v of vars) {
                if (!seen.has(v.name)) {
                    seen.add(v.name);
                    allVars.push(v);
                }
            }
        }
        return allVars
            .filter((v) => !INTERNAL_VARS.has(v.name))
            .map((v) => ({ key: v.name, label: toLabel(v.name) }));
    }
    const vars = extractNode.variables;
    if (!Array.isArray(vars))
        return [];
    return vars
        .filter((v) => !INTERNAL_VARS.has(v.name))
        .map((v) => ({ key: v.name, label: toLabel(v.name) }));
}
// ── Push to Retell API ───────────────────────────────────────────────────────
export async function pushFlowToRetell(retell, flowId, canonicalJson) {
    const flow = canonicalJson.conversationFlow;
    if (!flow)
        throw new Error("Missing conversationFlow in canonical JSON");
    const params = extractFlowParams(flow);
    await retell.conversationFlow.update(flowId, params);
}
// ── Fetch from Retell API ────────────────────────────────────────────────────
export async function fetchRetellAgent(retell, agentId) {
    // 1. Fetch agent
    const agent = await retell.agent.retrieve(agentId);
    const agentObj = agent;
    // 2. Extract conversation flow ID
    const responseEngine = agentObj.response_engine;
    if (!responseEngine || responseEngine.type !== "conversation-flow") {
        throw new Error(`Agent ${agentId} does not use a conversation-flow response engine`);
    }
    const conversationFlowId = responseEngine.conversation_flow_id;
    if (!conversationFlowId) {
        throw new Error(`Agent ${agentId} has no conversation_flow_id`);
    }
    // 3. Fetch conversation flow
    const flow = await retell.conversationFlow.retrieve(conversationFlowId);
    const flowObj = flow;
    // 4. Reconstruct canonical JSON (same format as generator output)
    const canonicalJson = { ...agentObj };
    canonicalJson.conversationFlow = flowObj;
    // Remove the response_engine that references the flow by ID
    // (canonical format has it nested instead)
    delete canonicalJson.response_engine;
    canonicalJson.response_engine = {
        type: "conversation-flow",
        version: 1,
    };
    // 5. Extract variables
    const variables = extractVariables(canonicalJson);
    return {
        agentId,
        agentName: agentObj.agent_name ?? "",
        conversationFlowId,
        variables,
        canonicalJson,
    };
}
