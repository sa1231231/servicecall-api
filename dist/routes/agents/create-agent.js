import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { notificationClients } from "../../config/notification-clients.js";
import { persistClient, } from "../../config/client-store.js";
import { generateAgent, } from "../../lib/agent-generator/index.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../../lib/agent-generator/output");
// ── Label Mapping ────────────────────────────────────────────────────────────
const LABEL_MAP = {
    full_name: "Name",
    phone_number: "Phone",
    street_address: "Address",
    city: "City",
    email: "Email",
    company_name: "Company",
    problem_description: "Problem",
    preferred_time: "Preferred Time",
    preferred_day: "Preferred Day",
};
function toLabel(variableName, dataPointLabel) {
    if (dataPointLabel && dataPointLabel !== variableName)
        return dataPointLabel;
    if (LABEL_MAP[variableName])
        return LABEL_MAP[variableName];
    return variableName
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}
// ── Derive Notification Config ───────────────────────────────────────────────
function deriveNotificationConfig(resolved, clientInfo, agentId) {
    // Collect all variable names and labels (expand composites)
    const variables = [];
    for (const dp of resolved) {
        if (dp.composite && dp.variables) {
            for (const v of dp.variables) {
                variables.push({ key: v.variableName, label: toLabel(v.variableName) });
            }
        }
        else {
            variables.push({ key: dp.variableName, label: toLabel(dp.variableName, dp.label) });
        }
    }
    // Filter out internal variables
    const fields = variables
        .filter((v) => v.key !== "phone_number_collected")
        .map((v) => ({ key: v.key, label: v.label }));
    // Check if is_emergency is among the variables
    const hasEmergency = variables.some((v) => v.key === "is_emergency");
    // Build subject template from available fields
    const hasName = fields.some((f) => f.key === "full_name");
    const hasAddress = fields.some((f) => f.key === "street_address");
    const hasCity = fields.some((f) => f.key === "city");
    let subjectParts = "";
    if (hasName)
        subjectParts += "{{full_name}}";
    if (hasAddress)
        subjectParts += ` — {{street_address}}`;
    if (hasCity)
        subjectParts += `, {{city}}`;
    // Build message types
    const messageTypes = {};
    let resolveRule;
    let defaultMessageType;
    if (hasEmergency) {
        // Critical fields for emergency: name, phone, address, city, problem
        const criticalKeys = new Set([
            "full_name",
            "phone_number",
            "street_address",
            "city",
            "problem_description",
        ]);
        const emergencyFields = fields.filter((f) => criticalKeys.has(f.key));
        messageTypes.emergency = {
            label: "EMERGENCY CALL",
            subject_template: `EMERGENCY: ${subjectParts}`.trim(),
            additional_text: "Caller expects contact within 10 minutes.",
            fields: emergencyFields.length > 0 ? emergencyFields : fields,
        };
        messageTypes.service_request = {
            label: "New Service Request",
            subject_template: `Service Request: ${subjectParts}`.trim(),
            fields,
        };
        resolveRule = {
            field: "is_emergency",
            equals: "true",
            then: "emergency",
            else: "service_request",
        };
        defaultMessageType = "service_request";
    }
    else {
        messageTypes.service_request = {
            label: "New Service Request",
            subject_template: `Service Request: ${subjectParts}`.trim(),
            fields,
        };
        defaultMessageType = "service_request";
    }
    return {
        name: clientInfo.name ?? clientInfo.slug,
        agent_ids: [agentId],
        dispatch_text_numbers: clientInfo.dispatch_text_numbers,
        dispatch_call_number: clientInfo.dispatch_call_number ?? null,
        summary_agent_id: clientInfo.summary_agent_id ?? null,
        outbound_from_number: clientInfo.outbound_from_number ?? null,
        dispatch_email: clientInfo.dispatch_email ?? null,
        dispatch_cc: clientInfo.dispatch_cc ?? null,
        resolve_rule: resolveRule,
        message_types: messageTypes,
        default_message_type: defaultMessageType,
        phone_fallback_to_caller: clientInfo.phone_fallback_to_caller ?? true,
        hide_not_mentioned: clientInfo.hide_not_mentioned ?? false,
        shadow_mode: clientInfo.shadow_mode ?? true,
    };
}
// ── Split Agent JSON for Retell SDK ──────────────────────────────────────────
// Fields that exist on the generated JSON but are NOT AgentCreateParams
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
// Fields that exist on conversationFlow but are NOT ConversationFlowCreateParams
const FLOW_STRIP_KEYS = new Set([
    "version",
    "is_published",
    "flex_mode",
    "is_transfer_cf",
]);
function extractFlowParams(conversationFlow) {
    const params = {};
    for (const [key, value] of Object.entries(conversationFlow)) {
        if (!FLOW_STRIP_KEYS.has(key)) {
            params[key] = value;
        }
    }
    return params;
}
function extractAgentParams(agentJson, conversationFlowId) {
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
// ── Handler ──────────────────────────────────────────────────────────────────
export async function createAgentHandler(req, res) {
    const body = req.body;
    // ── Validate ───────────────────────────────────────────────────────────────
    if (!body.business?.businessName || !body.business?.faqKnowledgeBase) {
        res.status(400).json({ error: "Missing required field: business.businessName and business.faqKnowledgeBase" });
        return;
    }
    if (!Array.isArray(body.dataPoints) || body.dataPoints.length === 0) {
        res.status(400).json({ error: "Missing required field: dataPoints (non-empty array)" });
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
    let conversationFlowId;
    try {
        // ── 1. Generate agent JSON ─────────────────────────────────────────────
        console.log(`[create-agent] generating agent for "${body.business.businessName}"`);
        const { agent: agentJson, resolved } = generateAgent(body.business, body.dataPoints);
        // ── 2. Save generated JSON to output ───────────────────────────────────
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        const slug = body.client.slug;
        const outputPath = path.join(OUTPUT_DIR, `${slug}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(agentJson, null, 2), "utf8");
        console.log(`[create-agent] saved agent JSON to ${outputPath}`);
        // ── 3. Create conversation flow in Retell ──────────────────────────────
        const conversationFlow = agentJson.conversationFlow;
        const flowParams = extractFlowParams(conversationFlow);
        console.log(`[create-agent] creating conversation flow in Retell...`);
        const flowResponse = await retell.conversationFlow.create(flowParams);
        conversationFlowId = flowResponse.conversation_flow_id;
        console.log(`[create-agent] conversation flow created: ${conversationFlowId}`);
        // ── 4. Create agent in Retell ──────────────────────────────────────────
        const agentParams = extractAgentParams(agentJson, conversationFlowId);
        console.log(`[create-agent] creating agent in Retell...`);
        const agentResponse = await retell.agent.create(agentParams);
        const agentId = agentResponse.agent_id;
        console.log(`[create-agent] agent created: ${agentId}`);
        // ── 5. Derive and persist notification config ──────────────────────────
        const jsonEntry = deriveNotificationConfig(resolved, body.client, agentId);
        const clientConfig = await persistClient(slug, jsonEntry);
        console.log(`[create-agent] client "${slug}" registered with agent ${agentId}`);
        // ── 6. Return response ─────────────────────────────────────────────────
        res.status(201).json({
            success: true,
            agent_id: agentId,
            conversation_flow_id: conversationFlowId,
            notification_config: jsonEntry,
        });
    }
    catch (err) {
        console.error("[create-agent] error:", err);
        // Cleanup: if we created a conversation flow but agent creation failed
        if (conversationFlowId) {
            try {
                console.log(`[create-agent] cleaning up conversation flow ${conversationFlowId}`);
                await retell.conversationFlow.delete(conversationFlowId);
            }
            catch (cleanupErr) {
                console.error("[create-agent] cleanup failed:", cleanupErr);
            }
        }
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(502).json({ error: "Failed to create agent in Retell", details: message });
    }
}
