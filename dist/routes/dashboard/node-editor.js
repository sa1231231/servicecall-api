import { Router } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { getClientDocument, loadClientsFromDb } from "../../config/client-store.js";
import { getDb } from "../../lib/db.js";
import { fetchRetellAgent, pushFlowToRetell, extractVariables } from "../../lib/retell-sync.js";
import { parseConversationFlow } from "../../lib/node-parser.js";
import { validateConversationFlow } from "../../lib/node-validator.js";
import { createVersionSnapshot, listVersions, getVersion, getLatestVersion, } from "../../lib/agent-versions.js";
import { logAudit } from "../../lib/audit.js";
import { requireRoot } from "../../middleware/require-role.js";
import { deriveNotificationConfig, } from "../../lib/notification-config.js";
import { regenerateDataChain, applyRegeneratedChain } from "../../lib/node-regenerator.js";
import { getDataPointDefaults } from "../../lib/data-point-defaults.js";
import { resolveDataPoints } from "../../lib/agent-generator/generate-agent.js";
import { makeIdFactory, buildTransitionNode, buildDataChain, } from "../../lib/agent-generator/node-builders.js";
import { renderTemplate } from "../../lib/build-notification.js";
export const nodeEditorRouter = Router({ mergeParams: true });
function retell() {
    return new Retell({ apiKey: config.RETELL_API_KEY });
}
// ── Helpers ──────────────────────────────────────────────────────────────────
async function resolveAgentId(slug, agentIdParam) {
    const doc = await getClientDocument(slug);
    if (!doc)
        return null;
    const agentIds = doc.agent_ids ?? [];
    if (!agentIds.includes(agentIdParam))
        return null;
    return { doc, agentId: agentIdParam };
}
async function pullLatest(agentId) {
    const snapshot = await fetchRetellAgent(retell(), agentId);
    return snapshot;
}
async function storeCanonical(slug, agentId, canonicalJson, doc) {
    // Update the retell_agents entry and last_deployed_at
    await getDb()
        .collection("clients")
        .updateOne({ _id: slug }, {
        $set: {
            [`retell_agents.${agentId}`]: canonicalJson,
            last_deployed_at: new Date().toISOString(),
        },
    });
    // Re-derive notification config if variables changed
    const variables = extractVariables(canonicalJson);
    const clientInfo = {
        slug,
        name: doc.name,
        dispatch_text_numbers: doc.dispatch_text_numbers,
        dispatch_call_number: doc.dispatch_call_number,
        dispatch_email: doc.dispatch_email,
        dispatch_cc: doc.dispatch_cc,
        outbound_from_number: doc.outbound_from_number,
        summary_agent_id: doc.summary_agent_id,
        phone_fallback_to_caller: doc.phone_fallback_to_caller,
        hide_not_mentioned: doc.hide_not_mentioned,
        shadow_mode: doc.shadow_mode,
    };
    const derived = deriveNotificationConfig(variables, clientInfo, agentId);
    // Preserve existing field customizations
    if (doc.message_types) {
        const customizations = new Map();
        for (const existingType of Object.values(doc.message_types)) {
            for (const f of existingType.fields) {
                if (!customizations.has(f.key)) {
                    customizations.set(f.key, { show: f.show, label: f.label, required: f.required });
                }
            }
        }
        for (const newType of Object.values(derived.message_types)) {
            for (const field of newType.fields) {
                const existing = customizations.get(field.key);
                if (!existing)
                    continue;
                if (existing.show === false)
                    field.show = false;
                if (existing.label !== field.label)
                    field.label = existing.label;
                if (existing.required)
                    field.required = existing.required;
            }
        }
    }
    // Only overwrite message_types if keys match
    const existingKeys = Object.keys(doc.message_types || {}).sort().join(",");
    const newKeys = Object.keys(derived.message_types).sort().join(",");
    if (!doc.message_types || existingKeys === newKeys) {
        await getDb()
            .collection("clients")
            .updateOne({ _id: slug }, {
            $set: {
                message_types: derived.message_types,
                default_message_type: derived.default_message_type,
            },
        });
    }
    await loadClientsFromDb();
}
// ── GET /:agentId — View Node Structure ──────────────────────────────────────
nodeEditorRouter.get("/:agentId", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        // Pull latest from Retell
        const snapshot = await pullLatest(agentId);
        // Store in MongoDB
        await getDb()
            .collection("clients")
            .updateOne({ _id: slug }, {
            $set: { [`retell_agents.${agentId}`]: snapshot.canonicalJson },
        });
        // Parse into structured representation
        const parsed = parseConversationFlow(snapshot.canonicalJson);
        const latestVersion = await getLatestVersion(slug, agentId);
        // Extract transition conditions from intro node edges
        const introEdges = parsed.introNode.raw.edges;
        const transitionConditions = {};
        if (Array.isArray(introEdges)) {
            for (const path of parsed.paths) {
                const edge = introEdges.find((e) => e.destination_node_id === path.transitionNode.id);
                if (edge) {
                    const tc = edge.transition_condition;
                    transitionConditions[path.name] = tc?.prompt ?? "";
                }
            }
        }
        // Extract FAQ knowledge base from FAQ node
        let faqKnowledgeBase = "";
        let faqNodeId;
        if (parsed.faqNode) {
            faqNodeId = parsed.faqNode.id;
            const instr = parsed.faqNode.raw.instruction;
            const fullText = instr?.text ?? "";
            // FAQ prompt format: "Your goal is to answer...\n\n{faqContent}"
            const faqPrefix = "Your goal is to answer administrative and general questions briefly and accurately.\n\n";
            faqKnowledgeBase = fullText.startsWith(faqPrefix)
                ? fullText.slice(faqPrefix.length)
                : fullText;
        }
        // Extract branch conditions from data points
        function extractBranchConditions(dp) {
            // Check the router edge for this data point's branch conditions
            const routerEdges = parsed.paths
                .flatMap((p) => {
                const re = p.routerNode.raw.edges;
                return (re ?? []).filter((e) => e.destination_node_id === dp.collectNode.id);
            });
            if (routerEdges.length === 0)
                return undefined;
            const edge = routerEdges[0];
            const tc = edge.transition_condition;
            if (tc?.type !== "equation")
                return undefined;
            const eqs = tc.equations;
            if (!Array.isArray(eqs))
                return undefined;
            // Find branch condition equations (not the "is missing" checks)
            const branchEqs = eqs.filter((eq) => {
                const left = eq.left;
                // Skip the standard "is missing" equations for this variable
                if (left === `{{${dp.variableName}}}`)
                    return false;
                if (left === `{{phone_number_collected}}`)
                    return false;
                // Skip composite variable checks
                const isComposite = dp.variableDefs.some((v) => left === `{{${v.name}}}`);
                if (isComposite)
                    return false;
                return true;
            });
            if (branchEqs.length === 0)
                return undefined;
            return branchEqs.map((eq) => ({
                variable: eq.left.replace(/^\{\{|\}\}$/g, ""),
                operator: eq.operator,
                value: eq.right,
            }));
        }
        // Detect human request mode
        const humanReqNode = parsed.allNodes.find((n) => n.name === "Human Request");
        const hasTransferCall = parsed.allNodes.some((n) => n.name === "Transfer Call");
        const humanRequestMode = hasTransferCall ? "live_transfer" : "callback";
        // Intro node prompt
        const introInstruction = parsed.introNode.raw.instruction;
        const introPrompt = introInstruction?.text ?? "";
        // Closing node prompts (find by name)
        const findInstructionText = (nodeName) => {
            const node = parsed.allNodes.find((n) => n.name === nodeName);
            const instr = node?.raw.instruction;
            return instr?.text ?? "";
        };
        const closePrompt = findInstructionText("Close");
        const closingRemarksPrompt = findInstructionText("Closing Remarks");
        const closingStatementText = findInstructionText("Closing Statement");
        // Live Transfer Recovery — only present on agents created after the feature
        // shipped. Strict name match; do not fall back to the legacy "Transfer Failed".
        // Field omitted from the response when the node is absent so the dashboard
        // can hide the editor section for older agents.
        const liveTransferRecoveryNode = parsed.allNodes.find((n) => n.name === "Live Transfer Recovery");
        const liveTransferRecoveryInstr = liveTransferRecoveryNode?.raw.instruction;
        const liveTransferRecoveryPrompt = liveTransferRecoveryNode
            ? (liveTransferRecoveryInstr?.text ?? "")
            : undefined;
        res.json({
            agentId,
            agentName: snapshot.agentName,
            conversationFlowId: snapshot.conversationFlowId,
            globalPrompt: parsed.globalPrompt,
            startNodeId: parsed.startNodeId,
            versionNumber: latestVersion?.version ?? 0,
            introNodeId: parsed.introNode.id,
            introPrompt,
            transitionPrompt: parsed.paths.length > 0
                ? (parsed.paths[0].transitionNode.raw.instruction?.text ?? "")
                : "",
            transitionNodeIds: parsed.paths.map((p) => p.transitionNode.id),
            faqNodeId,
            faqKnowledgeBase,
            closePrompt,
            closingRemarksPrompt,
            closingStatementText,
            ...(liveTransferRecoveryPrompt !== undefined && { liveTransferRecoveryPrompt }),
            humanRequestMode,
            humanRequestNodeId: humanReqNode?.id,
            transitionConditions,
            paths: parsed.paths.map((p) => ({
                name: p.name,
                transitionNodeId: p.transitionNode.id,
                frontExtractNodeId: p.frontExtractNode.id,
                routerNodeId: p.routerNode.id,
                transitionCondition: transitionConditions[p.name] ?? "",
                endMode: p.endMode,
                transferDestination: p.transferDestination,
                dataPoints: p.dataChain.map((dp) => ({
                    variableName: dp.variableName,
                    label: dp.label,
                    collectNodeId: dp.collectNode.id,
                    confirmNodeId: dp.confirmNode.id,
                    conversationPrompt: dp.conversationPrompt,
                    forwardCondition: dp.forwardCondition,
                    variableDefs: dp.variableDefs,
                    branchConditions: extractBranchConditions(dp),
                })),
            })),
            nodes: parsed.allNodes.map((n) => ({
                id: n.id,
                name: n.name,
                type: n.type,
                isGlobal: !!n.raw.global_node_setting,
                promptPreview: n.raw.instruction?.text
                    ? String(n.raw.instruction.text).slice(0, 200)
                    : undefined,
            })),
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] GET /${slug}/${agentId} error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── GET /:agentId/versions — List Version History ────────────────────────────
nodeEditorRouter.get("/:agentId/versions", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Number(req.query.offset) || 0;
    const result = await listVersions(slug, agentId, { limit, offset });
    res.json({
        versions: result.versions.map((v) => ({
            _id: v._id,
            version: v.version,
            source: v.source,
            description: v.description,
            createdBy: v.createdBy,
            createdAt: v.createdAt,
            nodeCount: v.nodeCount,
            dataPointCount: v.dataPointCount,
        })),
        total: result.total,
    });
});
// ── GET /:agentId/versions/:versionId — Get Specific Version ─────────────────
nodeEditorRouter.get("/:agentId/versions/:versionId", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const versionId = p.versionId;
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const version = await getVersion(versionId);
        if (!version || version.slug !== slug || version.agentId !== agentId) {
            res.status(404).json({ error: "Version not found" });
            return;
        }
        // Parse the version's canonical JSON for structured display
        const parsed = parseConversationFlow(version.canonicalJson);
        res.json({
            _id: version._id,
            version: version.version,
            source: version.source,
            description: version.description,
            createdBy: version.createdBy,
            createdAt: version.createdAt,
            nodeCount: version.nodeCount,
            dataPointCount: version.dataPointCount,
            globalPrompt: parsed.globalPrompt,
            paths: parsed.paths.map((p) => ({
                name: p.name,
                dataPoints: p.dataChain.map((dp) => ({
                    variableName: dp.variableName,
                    label: dp.label,
                    conversationPrompt: dp.conversationPrompt,
                })),
            })),
            nodes: parsed.allNodes.map((n) => ({
                id: n.id,
                name: n.name,
                type: n.type,
            })),
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/edit-prompt — Edit Node Prompt ────────────────────────────
nodeEditorRouter.post("/:agentId/edit-prompt", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { nodeId, instruction } = req.body;
    if (!nodeId || typeof instruction !== "string" || instruction.trim().length === 0) {
        res.status(400).json({ error: "nodeId and instruction (non-empty string) are required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        // Pull latest from Retell
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const flow = canonical.conversationFlow;
        const nodes = flow.nodes;
        // Find the target node
        const targetNode = nodes.find((n) => n.id === nodeId);
        if (!targetNode) {
            res.status(404).json({ error: `Node "${nodeId}" not found` });
            return;
        }
        if (targetNode.type !== "conversation") {
            res.status(400).json({ error: "Can only edit prompt on conversation nodes" });
            return;
        }
        // Snapshot before edit
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Edit prompt on node "${targetNode.name}"`, req.user?.username ?? "unknown");
        // Apply edit
        const existingInstruction = targetNode.instruction;
        existingInstruction.text = instruction;
        // Validate
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        // Store in MongoDB (no Retell push — user publishes explicitly)
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "edit_node_prompt", `${slug}/${agentId}`, { nodeId, nodeName: targetNode.name });
        res.json({ success: true, nodeId, nodeName: targetNode.name });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-prompt error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/edit-global-prompt — Edit Global Prompt ───────────────────
nodeEditorRouter.post("/:agentId/edit-global-prompt", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { globalPrompt } = req.body;
    if (typeof globalPrompt !== "string" || globalPrompt.trim().length === 0) {
        res.status(400).json({ error: "globalPrompt (non-empty string) is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const flow = canonical.conversationFlow;
        // Snapshot before edit
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", "Edit global prompt", req.user?.username ?? "unknown");
        // Apply edit
        flow.global_prompt = globalPrompt;
        // Validate
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        // Push to Retell
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "edit_global_prompt", `${slug}/${agentId}`);
        res.json({ success: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-global-prompt error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/edit-transition — Edit Path Transition Condition ──────────
nodeEditorRouter.post("/:agentId/edit-transition", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { pathName, transitionCondition } = req.body;
    if (!pathName || typeof pathName !== "string") {
        res.status(400).json({ error: "pathName (string) is required" });
        return;
    }
    if (typeof transitionCondition !== "string" || transitionCondition.trim().length === 0) {
        res.status(400).json({ error: "transitionCondition (non-empty string) is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const parsed = parseConversationFlow(canonical);
        // Find the target path's transition node
        const targetPath = parsed.paths.find((pa) => pa.name === pathName);
        if (!targetPath) {
            res.status(404).json({
                error: `Path "${pathName}" not found`,
                availablePaths: parsed.paths.map((pa) => pa.name),
            });
            return;
        }
        // Find the intro node edge that points to this path's transition node
        const introNode = parsed.introNode.raw;
        const edges = introNode.edges;
        const targetEdge = edges.find((e) => e.destination_node_id === targetPath.transitionNode.id);
        if (!targetEdge) {
            res.status(500).json({ error: "Could not find transition edge for this path" });
            return;
        }
        // Snapshot before edit
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Edit transition condition for path "${pathName}"`, req.user?.username ?? "unknown");
        // Update the edge's transition condition
        targetEdge.transition_condition.prompt = transitionCondition;
        // Validate
        const flow = canonical.conversationFlow;
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        // Push to Retell
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "edit_transition", `${slug}/${agentId}`, { pathName, transitionCondition });
        res.json({ success: true, pathName });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-transition error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/edit-agent-settings — Edit Agent-Level Settings ───────────
nodeEditorRouter.post("/:agentId/edit-agent-settings", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const ALLOWED_SETTINGS = new Set([
        "agent_name", "voice_id", "voice_speed", "voice_temperature",
        "volume", "enable_backchannel", "backchannel_frequency",
        "interruption_sensitivity", "ambient_sound", "ambient_sound_volume",
        "responsiveness", "begin_message_delay_ms", "reminder_trigger_ms",
        "reminder_max_count", "end_call_after_silence_ms", "max_call_duration_ms",
        "language", "webhook_url",
    ]);
    const updates = {};
    for (const [key, value] of Object.entries(req.body)) {
        if (ALLOWED_SETTINGS.has(key)) {
            updates[key] = value;
        }
    }
    if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: "No valid settings provided", allowed: [...ALLOWED_SETTINGS] });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        // Snapshot current state
        const snapshot = await pullLatest(agentId);
        await createVersionSnapshot(slug, agentId, snapshot.canonicalJson, "manual_edit", `Edit agent settings: ${Object.keys(updates).join(", ")}`, req.user?.username ?? "unknown");
        // Push agent-level updates to Retell
        await retell().agent.update(agentId, updates);
        // Fetch fresh state and store
        const fresh = await pullLatest(agentId);
        await storeCanonical(slug, agentId, fresh.canonicalJson, resolved.doc);
        await logAudit(req, "edit_agent_settings", `${slug}/${agentId}`, { fields: Object.keys(updates) });
        res.json({ success: true, updated: Object.keys(updates) });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-agent-settings error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/rollback — Restore From Version Snapshot ──────────────────
nodeEditorRouter.post("/:agentId/rollback", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const versionId = req.body.versionId;
    if (!versionId) {
        res.status(400).json({ error: "versionId is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        // Get the version to restore
        const version = await getVersion(versionId);
        if (!version || version.slug !== slug || version.agentId !== agentId) {
            res.status(404).json({ error: "Version not found" });
            return;
        }
        // Pull current state and snapshot it
        const currentSnapshot = await pullLatest(agentId);
        await createVersionSnapshot(slug, agentId, currentSnapshot.canonicalJson, "rollback", `Pre-rollback snapshot (before restoring version ${version.version})`, req.user?.username ?? "unknown");
        // Validate the old version
        const oldFlow = version.canonicalJson.conversationFlow;
        if (!oldFlow) {
            res.status(400).json({ error: "Version has no conversationFlow" });
            return;
        }
        const errors = validateConversationFlow(oldFlow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Version failed validation", errors });
            return;
        }
        // Push old version to Retell
        await pushFlowToRetell(retell(), currentSnapshot.conversationFlowId, version.canonicalJson);
        // Check if agent-level settings differ
        const oldAgent = version.canonicalJson;
        const currentAgent = currentSnapshot.canonicalJson;
        const agentUpdates = {};
        for (const key of ["agent_name", "voice_id", "voice_speed", "voice_temperature", "volume"]) {
            if (oldAgent[key] !== undefined && oldAgent[key] !== currentAgent[key]) {
                agentUpdates[key] = oldAgent[key];
            }
        }
        if (Object.keys(agentUpdates).length > 0) {
            await retell().agent.update(agentId, agentUpdates);
        }
        // Fetch fresh state and store
        const fresh = await pullLatest(agentId);
        await storeCanonical(slug, agentId, fresh.canonicalJson, resolved.doc);
        // Re-derive path_end_modes from the rolled-back flow so the MongoDB
        // shorthand stays in sync with the restored Pre-Transfer / Transfer Call
        // structure. Without this, the dashboard's stored end-mode field could
        // disagree with what's actually in the flow.
        try {
            const restoredParsed = parseConversationFlow(fresh.canonicalJson);
            const nextEndModes = {};
            for (const pp of restoredParsed.paths) {
                if (pp.endMode === "transfer")
                    nextEndModes[pp.name] = "transfer";
            }
            await getDb()
                .collection("clients")
                .updateOne({ _id: slug }, { $set: { path_end_modes: nextEndModes } });
            await loadClientsFromDb();
        }
        catch (e) {
            console.warn(`[node-editor] rollback: could not re-derive path_end_modes: ${e instanceof Error ? e.message : e}`);
        }
        // Snapshot the restored state
        await createVersionSnapshot(slug, agentId, fresh.canonicalJson, "rollback", `Restored from version ${version.version}`, req.user?.username ?? "unknown");
        await logAudit(req, "rollback_agent", `${slug}/${agentId}`, {
            restoredVersion: version.version,
            versionId,
        });
        res.json({
            success: true,
            restoredVersion: version.version,
            agentSettingsUpdated: Object.keys(agentUpdates),
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] rollback error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/add-data-point — Add Data Collection Question ─────────────
nodeEditorRouter.post("/:agentId/add-data-point", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { dataPointKey, pathName, position } = req.body;
    if (!dataPointKey || typeof dataPointKey !== "string") {
        res.status(400).json({ error: "dataPointKey (string) is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        // Resolve data point from defaults
        const defaults = await getDataPointDefaults();
        let newDp;
        try {
            const resolved_dps = resolveDataPoints([dataPointKey], defaults);
            newDp = resolved_dps[0];
        }
        catch {
            res.status(400).json({ error: `Unknown data point key "${dataPointKey}"` });
            return;
        }
        // Pull latest and parse
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const parsed = parseConversationFlow(canonical);
        // Find target path
        const targetPath = findPath(parsed.paths, pathName);
        if (!targetPath) {
            res.status(404).json({
                error: pathName
                    ? `Path "${pathName}" not found`
                    : "No path found in agent",
                availablePaths: parsed.paths.map((p) => p.name),
            });
            return;
        }
        // Check if variable already exists
        const existingVars = targetPath.dataChain.map((dp) => dp.variableName);
        if (existingVars.includes(newDp.variableName)) {
            res.status(400).json({
                error: `Variable "${newDp.variableName}" already exists in path "${targetPath.name}"`,
            });
            return;
        }
        // Build updated data points list
        const currentDataPoints = buildDataPointsFromChain(targetPath, defaults);
        const insertAt = typeof position === "number"
            ? Math.min(Math.max(0, position), currentDataPoints.length)
            : currentDataPoints.length;
        currentDataPoints.splice(insertAt, 0, newDp);
        // Snapshot before edit
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Add data point "${newDp.label}" to path "${targetPath.name}" at position ${insertAt}`, req.user?.username ?? "unknown");
        // Find close node
        const closeNodeId = parsed.closeNode?.id;
        if (!closeNodeId) {
            res.status(500).json({ error: "Could not find Close node in flow" });
            return;
        }
        // Regenerate chain
        const result = regenerateDataChain(targetPath, currentDataPoints, closeNodeId, targetPath.name === "Default" ? undefined : targetPath.name);
        applyRegeneratedChain(canonical, result);
        // Validate
        const flow = canonical.conversationFlow;
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed after regeneration", errors });
            return;
        }
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "add_data_point", `${slug}/${agentId}`, {
            dataPointKey,
            pathName: targetPath.name,
            position: insertAt,
        });
        res.json({
            success: true,
            variableName: newDp.variableName,
            label: newDp.label,
            position: insertAt,
            pathName: targetPath.name,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] add-data-point error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/remove-data-point — Remove Data Collection Question ──────
nodeEditorRouter.post("/:agentId/remove-data-point", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { variableName, pathName } = req.body;
    if (!variableName || typeof variableName !== "string") {
        res.status(400).json({ error: "variableName (string) is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const defaults = await getDataPointDefaults();
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const parsed = parseConversationFlow(canonical);
        const targetPath = findPath(parsed.paths, pathName);
        if (!targetPath) {
            res.status(404).json({ error: pathName ? `Path "${pathName}" not found` : "No path found" });
            return;
        }
        const existingVars = targetPath.dataChain.map((dp) => dp.variableName);
        if (!existingVars.includes(variableName)) {
            res.status(404).json({
                error: `Variable "${variableName}" not found in path "${targetPath.name}"`,
                existingVariables: existingVars,
            });
            return;
        }
        if (existingVars.length <= 1) {
            res.status(400).json({ error: "Cannot remove the last data point from a path" });
            return;
        }
        // Build updated data points list without the removed one
        const currentDataPoints = buildDataPointsFromChain(targetPath, defaults);
        const filtered = currentDataPoints.filter((dp) => dp.variableName !== variableName);
        // Snapshot
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Remove data point "${variableName}" from path "${targetPath.name}"`, req.user?.username ?? "unknown");
        const closeNodeId = parsed.closeNode?.id;
        if (!closeNodeId) {
            res.status(500).json({ error: "Could not find Close node" });
            return;
        }
        const result = regenerateDataChain(targetPath, filtered, closeNodeId, targetPath.name === "Default" ? undefined : targetPath.name);
        applyRegeneratedChain(canonical, result);
        const flow = canonical.conversationFlow;
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed after regeneration", errors });
            return;
        }
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "remove_data_point", `${slug}/${agentId}`, {
            variableName,
            pathName: targetPath.name,
        });
        res.json({ success: true, variableName, pathName: targetPath.name });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] remove-data-point error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/reorder-data-points — Reorder Questions ──────────────────
nodeEditorRouter.post("/:agentId/reorder-data-points", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { variableNames, pathName } = req.body;
    if (!Array.isArray(variableNames) || variableNames.length === 0) {
        res.status(400).json({ error: "variableNames (non-empty string array) is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const defaults = await getDataPointDefaults();
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const parsed = parseConversationFlow(canonical);
        const targetPath = findPath(parsed.paths, pathName);
        if (!targetPath) {
            res.status(404).json({ error: pathName ? `Path "${pathName}" not found` : "No path found" });
            return;
        }
        // Validate that the variable names match
        const existingVars = new Set(targetPath.dataChain.map((dp) => dp.variableName));
        const providedVars = new Set(variableNames);
        const missing = [...existingVars].filter((v) => !providedVars.has(v));
        const extra = [...providedVars].filter((v) => !existingVars.has(v));
        if (missing.length > 0 || extra.length > 0) {
            res.status(400).json({
                error: "variableNames must contain exactly the same variables as the current path",
                missing,
                extra,
            });
            return;
        }
        // Build reordered data points list
        const currentDataPoints = buildDataPointsFromChain(targetPath, defaults);
        const dpMap = new Map(currentDataPoints.map((dp) => [dp.variableName, dp]));
        const reordered = variableNames.map((name) => dpMap.get(name));
        // Snapshot
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Reorder data points in path "${targetPath.name}"`, req.user?.username ?? "unknown");
        const closeNodeId = parsed.closeNode?.id;
        if (!closeNodeId) {
            res.status(500).json({ error: "Could not find Close node" });
            return;
        }
        const result = regenerateDataChain(targetPath, reordered, closeNodeId, targetPath.name === "Default" ? undefined : targetPath.name);
        applyRegeneratedChain(canonical, result);
        const flow = canonical.conversationFlow;
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed after regeneration", errors });
            return;
        }
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "reorder_data_points", `${slug}/${agentId}`, {
            variableNames,
            pathName: targetPath.name,
        });
        res.json({ success: true, variableNames, pathName: targetPath.name });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] reorder-data-points error:`, msg);
        res.status(500).json({ error: msg });
    }
});
function findPath(paths, pathName) {
    if (!pathName)
        return paths[0];
    return paths.find((p) => p.name === pathName);
}
/**
 * Reconstructs DataPoint[] from a parsed path's data chain.
 * Uses the confirm node's variables and collect node's prompts.
 */
function buildDataPointsFromChain(path, defaults) {
    return path.dataChain.map((dp) => {
        // Try to find the default definition first
        const defaultDp = defaults[dp.variableName];
        // Build from what we have in the existing nodes
        const varDef = dp.variableDefs[0];
        const result = {
            label: dp.label,
            variableName: dp.variableName,
            type: varDef?.type ?? "string",
            choices: varDef?.choices ?? [],
            description: varDef?.description ?? "",
            conversationPrompt: dp.conversationPrompt,
            forwardCondition: dp.forwardCondition,
            finetuneExamples: [],
            extractSuccessEquation: defaultDp?.extractSuccessEquation ?? [
                { left: `{{${dp.variableName}}}`, operator: "exists" },
                { left: `{{${dp.variableName}}}`, operator: "!=", right: "Not Mentioned" },
            ],
        };
        // For composite data points: the collect node name == label (no "Collect " prefix)
        const isComposite = !dp.collectNode.name.startsWith("Collect ");
        if (isComposite && dp.variableDefs.length > 1) {
            result.composite = true;
            result.variables = dp.variableDefs.map((v) => ({
                variableName: v.name,
                type: v.type,
                choices: v.choices,
                description: v.description,
            }));
        }
        return result;
    });
}
// ── POST /:agentId/edit-branch-condition — Set/Remove Branch on Data Point ───
nodeEditorRouter.post("/:agentId/edit-branch-condition", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { variableName, pathName, branchConditions } = req.body;
    if (!variableName || typeof variableName !== "string") {
        res.status(400).json({ error: "variableName (string) is required" });
        return;
    }
    // branchConditions: null to remove, or array of { variable, operator, value }
    if (branchConditions !== null && !Array.isArray(branchConditions)) {
        res.status(400).json({ error: "branchConditions must be null (to remove) or an array of { variable, operator, value }" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const defaults = await getDataPointDefaults();
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const parsed = parseConversationFlow(canonical);
        const targetPath = findPath(parsed.paths, pathName);
        if (!targetPath) {
            res.status(404).json({ error: pathName ? `Path "${pathName}" not found` : "No path found" });
            return;
        }
        const existingVars = targetPath.dataChain.map((dp) => dp.variableName);
        if (!existingVars.includes(variableName)) {
            res.status(404).json({ error: `Variable "${variableName}" not found in path` });
            return;
        }
        // Build data points with updated branch conditions
        const currentDataPoints = buildDataPointsFromChain(targetPath, defaults);
        for (const dp of currentDataPoints) {
            if (dp.variableName === variableName) {
                if (branchConditions === null) {
                    delete dp._branchConditions;
                }
                else {
                    dp._branchConditions = branchConditions.map((bc) => ({
                        variable: bc.variable,
                        operator: bc.operator,
                        value: bc.value,
                    }));
                }
            }
        }
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", branchConditions === null
            ? `Remove branch condition from "${variableName}"`
            : `Set branch condition on "${variableName}"`, req.user?.username ?? "unknown");
        const closeNodeId = parsed.closeNode?.id;
        if (!closeNodeId) {
            res.status(500).json({ error: "Could not find Close node" });
            return;
        }
        const result = regenerateDataChain(targetPath, currentDataPoints, closeNodeId, targetPath.name === "Default" ? undefined : targetPath.name);
        applyRegeneratedChain(canonical, result);
        const flow = canonical.conversationFlow;
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "edit_branch_condition", `${slug}/${agentId}`, {
            variableName,
            pathName: targetPath.name,
            branchConditions,
        });
        res.json({ success: true, variableName, pathName: targetPath.name });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-branch-condition error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/edit-path-name — Rename a Path ────────────────────────────
nodeEditorRouter.post("/:agentId/edit-path-name", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { oldName, newName } = req.body;
    if (!oldName || !newName || typeof oldName !== "string" || typeof newName !== "string") {
        res.status(400).json({ error: "oldName and newName (strings) are required" });
        return;
    }
    if (oldName === newName) {
        res.json({ success: true, pathName: newName });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const parsed = parseConversationFlow(canonical);
        const flow = canonical.conversationFlow;
        const nodes = flow.nodes;
        const targetPath = parsed.paths.find((pa) => pa.name === oldName);
        if (!targetPath) {
            res.status(404).json({ error: `Path "${oldName}" not found` });
            return;
        }
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Rename path "${oldName}" to "${newName}"`, req.user?.username ?? "unknown");
        // Update node names that contain the path suffix
        const oldSuffix = ` (${oldName})`;
        const newSuffix = ` (${newName})`;
        for (const node of nodes) {
            const name = node.name;
            if (name.endsWith(oldSuffix)) {
                node.name = name.replace(oldSuffix, newSuffix);
            }
        }
        // Update _path_taken variable description in front-extract node
        const frontExtract = nodes.find((n) => n.id === targetPath.frontExtractNode.id);
        if (frontExtract) {
            const vars = frontExtract.variables;
            if (Array.isArray(vars)) {
                const pathVar = vars.find((v) => v.name === "_path_taken");
                if (pathVar) {
                    pathVar.description = `Always set to "${newName}".`;
                }
            }
        }
        // Update MongoDB: message_types, resolve_rules, dispatch_by_type
        const doc = resolved.doc;
        const updates = {
            [`retell_agents.${agentId}`]: canonical,
            last_deployed_at: new Date().toISOString(),
        };
        // Rename message_types key
        if (doc.message_types) {
            const oldKey = oldName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            const newKey = newName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            const mt = { ...doc.message_types };
            if (mt[oldName]) {
                mt[newName] = { ...mt[oldName], label: newName };
                delete mt[oldName];
            }
            else if (mt[oldKey]) {
                mt[newKey] = { ...mt[oldKey], label: newName };
                delete mt[oldKey];
            }
            updates.message_types = mt;
            if (doc.default_message_type === oldName || doc.default_message_type === oldKey) {
                updates.default_message_type = mt[newName] ? newName : newKey;
            }
        }
        // Update resolve_rules
        if (doc.resolve_rules) {
            updates.resolve_rules = doc.resolve_rules.map((r) => ({
                ...r,
                equals: r.equals === oldName ? newName : r.equals,
                then: r.then === oldName ? newName : r.then,
            }));
        }
        // Rename dispatch_by_type key
        if (doc.dispatch_by_type) {
            const dbt = { ...doc.dispatch_by_type };
            const oldKey = oldName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            const newKey = newName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            if (dbt[oldName]) {
                dbt[newName] = dbt[oldName];
                delete dbt[oldName];
            }
            else if (dbt[oldKey]) {
                dbt[newKey] = dbt[oldKey];
                delete dbt[oldKey];
            }
            updates.dispatch_by_type = dbt;
        }
        // Rename path_end_modes key
        if (doc.path_end_modes) {
            const pem = { ...doc.path_end_modes };
            const oldKey = oldName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            const newKey = newName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
            if (pem[oldName]) {
                pem[newName] = pem[oldName];
                delete pem[oldName];
            }
            else if (pem[oldKey]) {
                pem[newKey] = pem[oldKey];
                delete pem[oldKey];
            }
            updates.path_end_modes = pem;
        }
        // Rename per-path Pre-Transfer / Transfer Call node display names
        for (const n of nodes) {
            const nm = n.name;
            if (!nm)
                continue;
            if (nm === `Pre-Transfer (${oldName})`)
                n.name = `Pre-Transfer (${newName})`;
            else if (nm === `Transfer Call (${oldName})`)
                n.name = `Transfer Call (${newName})`;
        }
        await getDb()
            .collection("clients")
            .updateOne({ _id: slug }, { $set: updates });
        await loadClientsFromDb();
        await logAudit(req, "edit_path_name", `${slug}/${agentId}`, { oldName, newName });
        res.json({ success: true, pathName: newName });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-path-name error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/edit-human-request-mode — Switch Callback/Transfer ────────
nodeEditorRouter.post("/:agentId/edit-human-request-mode", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { mode } = req.body;
    if (mode !== "callback" && mode !== "live_transfer") {
        res.status(400).json({ error: "mode must be 'callback' or 'live_transfer'" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const flow = canonical.conversationFlow;
        const nodes = flow.nodes;
        const parsed = parseConversationFlow(canonical);
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Change human request mode to "${mode}"`, req.user?.username ?? "unknown");
        // Find existing human request and transfer nodes
        const humanReqNode = nodes.find((n) => n.name === "Human Request");
        if (!humanReqNode) {
            res.status(500).json({ error: "Human Request node not found" });
            return;
        }
        const humanReqId = humanReqNode.id;
        const closingRemarksNode = nodes.find((n) => n.name === "Closing Remarks");
        const politeHangupNode = nodes.find((n) => n.name === "Polite Hangup");
        const closingRemarksId = closingRemarksNode?.id;
        const politeHangupId = politeHangupNode?.id;
        // Remove existing transfer nodes if switching to callback
        const transferCallIdx = nodes.findIndex((n) => n.name === "Transfer Call");
        const transferFailedIdx = nodes.findIndex((n) => n.name === "Transfer Failed");
        if (mode === "callback") {
            // Remove transfer nodes if they exist
            if (transferCallIdx >= 0)
                nodes.splice(transferCallIdx, 1);
            const newTfIdx = nodes.findIndex((n) => n.name === "Transfer Failed");
            if (newTfIdx >= 0)
                nodes.splice(newTfIdx, 1);
            // Update Human Request node to callback mode
            humanReqNode.instruction = {
                type: "prompt",
                text: `The caller is requesting a human or live person.\n\n1. Acknowledge the request calmly and professionally, saying they are not available at the moment.\n\n2. Tell them they have the option to request a call back. Ask the caller if they want a call back.\n\nIf the caller refuses and repeats the request for a human, repeat that you cannot transfer the call.`,
            };
            humanReqNode.edges = politeHangupId ? [{
                    destination_node_id: politeHangupId,
                    id: `edge-callback-${Date.now()}`,
                    transition_condition: { type: "prompt", prompt: "The caller wants a call back" },
                }] : [];
            delete humanReqNode.skip_response_edge;
            humanReqNode.global_node_setting = {
                go_back_conditions: [{
                        id: `go-back-${Date.now()}`,
                        transition_condition: { type: "prompt", prompt: "The caller would like to continue the call and not request a callback." },
                    }],
                condition: "Jump to this node if the caller requests a live agent or a human.",
            };
        }
        else {
            // Switch to live_transfer
            // Add Transfer Call and Transfer Failed nodes if missing
            const humanPos = humanReqNode.display_position ?? { x: -954, y: -1770 };
            if (transferCallIdx < 0) {
                const transferCallId = `node-transfer-${Date.now()}`;
                const transferFailedId = `node-transfer-failed-${Date.now() + 1}`;
                nodes.push({
                    custom_sip_headers: {},
                    transfer_destination: { type: "predefined", number: "{{dispatch_number}}" },
                    edge: {
                        destination_node_id: transferFailedId,
                        id: `edge-tf-${Date.now()}`,
                        transition_condition: { type: "prompt", prompt: "Transfer failed" },
                    },
                    name: "Transfer Call",
                    ignore_e164_validation: false,
                    id: transferCallId,
                    transfer_option: {
                        cold_transfer_mode: "sip_invite",
                        enable_bridge_audio_cue: true,
                        type: "cold_transfer",
                        agent_detection_timeout_ms: 30000,
                        show_transferee_as_caller: false,
                    },
                    type: "transfer_call",
                    speak_during_execution: false,
                    display_position: { x: humanPos.x + 360, y: humanPos.y + 96 },
                });
                nodes.push({
                    instruction: {
                        type: "prompt",
                        text: "Let the caller know you'll have their supervisor call them back as soon as possible. Do not ask them any more questions.",
                    },
                    always_edge: closingRemarksId ? {
                        destination_node_id: closingRemarksId,
                        id: `always-edge-tf-${Date.now()}`,
                        transition_condition: { type: "prompt", prompt: "Always" },
                    } : undefined,
                    name: "Transfer Failed",
                    edges: [],
                    id: transferFailedId,
                    type: "conversation",
                    display_position: { x: humanPos.x + 720, y: humanPos.y - 96 },
                });
                // Update Human Request to skip to Transfer Call
                humanReqNode.instruction = {
                    type: "prompt",
                    text: `The caller is requesting a human or live person.\n\nAcknowledge and tell them you will transfer the call.`,
                };
                humanReqNode.edges = [];
                humanReqNode.skip_response_edge = {
                    destination_node_id: transferCallId,
                    id: `skip-response-edge-hr-${Date.now()}`,
                    transition_condition: { type: "prompt", prompt: "Skip response" },
                };
                humanReqNode.global_node_setting = {
                    condition: "Jump to this node if the caller requests a live agent or a human.",
                    negative_finetune_examples: [],
                    positive_finetune_examples: [{
                            transcript: [{ content: "can I talk to the supervisor?", role: "user" }, { content: "", role: "agent" }],
                        }],
                };
            }
        }
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "edit_human_request_mode", `${slug}/${agentId}`, { mode });
        res.json({ success: true, mode });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-human-request-mode error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/edit-path-end-mode — Per-path Callback vs Live Transfer ───
//
// Switches a single routing path's end-of-flow behavior between:
//   - "callback": Variables Router (else) → shared Close node → hangup.
//                 Post-hook calls dispatch back later.
//   - "transfer": Variables Router (else) → per-path Pre-Transfer → per-path
//                 Transfer Call → SIP-invite caller to dispatch number.
//                 Post-hook still sends SMS/email but skips the redundant
//                 outbound dispatch call (TRANSFER_DISCONNECTION_REASONS).
//
// Mutates the canonical flow in place; persists path_end_modes on the client
// doc; takes an agent_versions snapshot. No Retell push — user publishes via
// save-and-publish.
nodeEditorRouter.post("/:agentId/edit-path-end-mode", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { pathName, mode } = req.body;
    if (!pathName || typeof pathName !== "string") {
        res.status(400).json({ error: "pathName is required" });
        return;
    }
    if (mode !== "callback" && mode !== "transfer") {
        res.status(400).json({ error: "mode must be 'callback' or 'transfer'" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    const doc = resolved.doc;
    // For transfer mode, ensure a dispatch call number is resolvable.
    let transferDestination = null;
    if (mode === "transfer") {
        const perPath = doc.dispatch_by_type?.[pathName]?.dispatch_call_number;
        const fallback = doc.dispatch_call_number;
        transferDestination = perPath || fallback || null;
        if (!transferDestination) {
            res.status(400).json({
                error: `Cannot set "${pathName}" to transfer: no dispatch call number is configured (per-path or client default).`,
            });
            return;
        }
    }
    try {
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const flow = canonical.conversationFlow;
        const nodes = flow.nodes;
        const parsed = parseConversationFlow(canonical);
        const targetPath = parsed.paths.find((pa) => pa.name === pathName);
        if (!targetPath) {
            res.status(404).json({ error: `Path "${pathName}" not found in flow` });
            return;
        }
        const closeNodeId = parsed.closeNode?.id;
        if (!closeNodeId) {
            res.status(500).json({ error: "Could not find Close node" });
            return;
        }
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", `Set path "${pathName}" end mode to "${mode}"`, req.user?.username ?? "unknown");
        const routerNode = nodes.find((n) => n.id === targetPath.routerNode.id);
        if (!routerNode) {
            res.status(500).json({ error: `Variables Router for path "${pathName}" not found` });
            return;
        }
        if (mode === "callback") {
            // Rewire the path's Variables Router else_edge → shared Close node.
            const elseEdge = routerNode.else_edge;
            if (elseEdge)
                elseEdge.destination_node_id = closeNodeId;
            // Remove this path's Pre-Transfer + Transfer Call nodes, if any.
            const removeNames = new Set([
                `Pre-Transfer (${pathName})`,
                `Transfer Call (${pathName})`,
            ]);
            for (let i = nodes.length - 1; i >= 0; i--) {
                if (removeNames.has(nodes[i].name))
                    nodes.splice(i, 1);
            }
            // Drop the shared Transfer Failed node if no transfer path or live-transfer
            // human-request mode remains.
            const stillHasTransferPath = parsed.paths.some((pa) => pa.name !== pathName && pa.endMode === "transfer");
            const liveTransferHumanReq = nodes.some((n) => n.name === "Transfer Call");
            if (!stillHasTransferPath && !liveTransferHumanReq) {
                const tfIdx = nodes.findIndex((n) => n.name === "Transfer Failed");
                if (tfIdx >= 0)
                    nodes.splice(tfIdx, 1);
            }
        }
        else {
            // mode === "transfer"
            // Ensure the shared Transfer Failed node exists.
            let transferFailedNode = nodes.find((n) => n.name === "Transfer Failed");
            const closingRemarks = nodes.find((n) => n.name === "Closing Remarks");
            const closingRemarksId = closingRemarks?.id;
            if (!transferFailedNode) {
                const transferFailedId = `node-transfer-failed-${Date.now()}`;
                transferFailedNode = {
                    instruction: {
                        type: "prompt",
                        text: "Let the caller know you'll have their supervisor call them back as soon as possible. Do not ask them any more questions.",
                    },
                    always_edge: closingRemarksId ? {
                        destination_node_id: closingRemarksId,
                        id: `always-edge-tf-${Date.now()}`,
                        transition_condition: { type: "prompt", prompt: "Always" },
                    } : undefined,
                    name: "Transfer Failed",
                    edges: [],
                    id: transferFailedId,
                    type: "conversation",
                    display_position: { x: -200, y: -1700 },
                };
                nodes.push(transferFailedNode);
            }
            const transferFailedId = transferFailedNode.id;
            // Find / create this path's Pre-Transfer + Transfer Call nodes.
            let preTransfer = nodes.find((n) => n.name === `Pre-Transfer (${pathName})`);
            let transferCall = nodes.find((n) => n.name === `Transfer Call (${pathName})`);
            const businessName = snapshot.agentName;
            const preTransferText = renderTemplate("Thanks for the information. Hold on a moment — connecting you to our team at {{business_name}} now.", { business_name: businessName });
            const routerPos = routerNode.display_position;
            const yBase = routerPos?.y ?? 450;
            if (!preTransfer) {
                const preTransferId = `node-pretransfer-${Date.now()}`;
                const transferCallId = `node-transfercall-${Date.now() + 1}`;
                preTransfer = {
                    instruction: { type: "prompt", text: preTransferText },
                    always_edge: {
                        destination_node_id: transferCallId,
                        id: `always-edge-pt-${Date.now()}`,
                        transition_condition: { type: "prompt", prompt: "Always" },
                    },
                    name: `Pre-Transfer (${pathName})`,
                    edges: [],
                    id: preTransferId,
                    type: "conversation",
                    display_position: { x: -18, y: yBase + 1350 },
                };
                nodes.push(preTransfer);
                transferCall = {
                    custom_sip_headers: {},
                    transfer_destination: { type: "predefined", number: transferDestination },
                    edge: {
                        destination_node_id: transferFailedId,
                        id: `edge-tc-${Date.now()}`,
                        transition_condition: { type: "prompt", prompt: "Transfer failed" },
                    },
                    name: `Transfer Call (${pathName})`,
                    ignore_e164_validation: false,
                    id: transferCallId,
                    transfer_option: {
                        cold_transfer_mode: "sip_invite",
                        enable_bridge_audio_cue: true,
                        type: "cold_transfer",
                        agent_detection_timeout_ms: 30000,
                        show_transferee_as_caller: false,
                    },
                    type: "transfer_call",
                    speak_during_execution: false,
                    display_position: { x: 540, y: yBase + 1350 },
                };
                nodes.push(transferCall);
            }
            else {
                // Refresh the destination number + always_edge target on existing nodes.
                if (transferCall) {
                    transferCall.transfer_destination.number = transferDestination;
                    const edge = transferCall.edge;
                    if (edge)
                        edge.destination_node_id = transferFailedId;
                }
                const ae = preTransfer.always_edge;
                if (ae && transferCall)
                    ae.destination_node_id = transferCall.id;
            }
            // Rewire Variables Router else_edge → Pre-Transfer.
            const elseEdge = routerNode.else_edge;
            if (elseEdge)
                elseEdge.destination_node_id = preTransfer.id;
        }
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        // Push to Retell now. Without this, the next GET pulls the old flow from
        // Retell and overwrites the canonical we just stored — making the radio
        // appear to revert. End-mode is a structural toggle with explicit user
        // intent, so publish it immediately (same pattern as rollback).
        await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);
        // Persist path_end_modes on the client doc.
        const nextEndModes = {
            ...(doc.path_end_modes ?? {}),
        };
        if (mode === "transfer")
            nextEndModes[pathName] = "transfer";
        else
            delete nextEndModes[pathName];
        await getDb()
            .collection("clients")
            .updateOne({ _id: slug }, {
            $set: {
                [`retell_agents.${agentId}`]: canonical,
                path_end_modes: nextEndModes,
                last_deployed_at: new Date().toISOString(),
            },
        });
        await loadClientsFromDb();
        await logAudit(req, "edit_path_end_mode", `${slug}/${agentId}`, { pathName, mode });
        res.json({ success: true, pathName, mode, transferDestination });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] edit-path-end-mode error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/save-and-publish — Apply All Changes & Push to Retell ─────
nodeEditorRouter.post("/:agentId/save-and-publish", async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const { changes } = req.body;
    if (!changes || typeof changes !== "object") {
        res.status(400).json({ error: "changes object is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        const defaults = await getDataPointDefaults();
        const snapshot = await pullLatest(agentId);
        const canonical = snapshot.canonicalJson;
        const flow = canonical.conversationFlow;
        const nodes = flow.nodes;
        const parsed = parseConversationFlow(canonical);
        // Snapshot before changes
        await createVersionSnapshot(slug, agentId, canonical, "manual_edit", changes.description || "Save & Publish", req.user?.username ?? "unknown");
        // Apply global prompt change
        if (typeof changes.globalPrompt === "string") {
            flow.global_prompt = changes.globalPrompt;
        }
        // Apply intro prompt change
        if (typeof changes.introPrompt === "string" && parsed.introNode) {
            const introNode = nodes.find((n) => n.id === parsed.introNode.id);
            if (introNode) {
                introNode.instruction.text = changes.introPrompt;
            }
        }
        // Apply transition prompt change (same text for all transition nodes)
        if (typeof changes.transitionPrompt === "string") {
            for (const path of parsed.paths) {
                const tNode = nodes.find((n) => n.id === path.transitionNode.id);
                if (tNode?.instruction) {
                    tNode.instruction.text = changes.transitionPrompt;
                }
            }
        }
        // Apply FAQ change
        if (typeof changes.faqKnowledgeBase === "string" && parsed.faqNode) {
            const faqNode = nodes.find((n) => n.id === parsed.faqNode.id);
            if (faqNode) {
                faqNode.instruction.text =
                    "Your goal is to answer administrative and general questions briefly and accurately.\n\n" + changes.faqKnowledgeBase;
            }
        }
        // Apply closing-prompt changes (Close, Closing Remarks, Closing Statement).
        // Substitute {{business_name}} → actual business name on the way to Retell.
        // Preserve existing instruction.type (Closing Statement is "static_text", others are "prompt").
        const businessName = snapshot.agentName;
        const tplVars = { business_name: businessName };
        const applyClosingPrompt = (nodeName, text) => {
            const node = nodes.find((n) => n.name === nodeName);
            if (node?.instruction) {
                node.instruction.text = renderTemplate(text, tplVars);
            }
        };
        if (typeof changes.closePrompt === "string") {
            applyClosingPrompt("Close", changes.closePrompt);
        }
        if (typeof changes.closingRemarksPrompt === "string") {
            applyClosingPrompt("Closing Remarks", changes.closingRemarksPrompt);
        }
        if (typeof changes.closingStatementText === "string") {
            applyClosingPrompt("Closing Statement", changes.closingStatementText);
        }
        // Live Transfer Recovery — strict name match. Older agents with "Transfer Failed"
        // are intentionally not touched; this only updates agents that have the new node.
        if (typeof changes.liveTransferRecoveryPrompt === "string") {
            applyClosingPrompt("Live Transfer Recovery", changes.liveTransferRecoveryPrompt);
        }
        // Apply individual node prompt changes
        if (changes.nodePrompts && typeof changes.nodePrompts === "object") {
            for (const [nodeId, text] of Object.entries(changes.nodePrompts)) {
                const node = nodes.find((n) => n.id === nodeId);
                if (node?.instruction) {
                    node.instruction.text = text;
                }
            }
        }
        // Apply transition condition changes
        if (changes.transitionConditions && typeof changes.transitionConditions === "object") {
            const introEdges = parsed.introNode.raw.edges;
            for (const [pathName, condition] of Object.entries(changes.transitionConditions)) {
                const targetPath = parsed.paths.find((pa) => pa.name === pathName);
                if (!targetPath)
                    continue;
                const edge = introEdges.find((e) => e.destination_node_id === targetPath.transitionNode.id);
                if (edge) {
                    edge.transition_condition.prompt = condition;
                }
            }
        }
        // Apply per-path data point changes (add/remove/reorder/branch)
        if (changes.paths && typeof changes.paths === "object") {
            const closeNodeId = parsed.closeNode?.id;
            if (!closeNodeId) {
                res.status(500).json({ error: "Could not find Close node" });
                return;
            }
            for (const [pathName, pathChanges] of Object.entries(changes.paths)) {
                const targetPath = parsed.paths.find((pa) => pa.name === pathName);
                if (!targetPath)
                    continue;
                // pathChanges.dataPointKeys = ordered list of data point keys for this path
                if (Array.isArray(pathChanges.dataPointKeys)) {
                    const newDataPoints = [];
                    for (const item of pathChanges.dataPointKeys) {
                        if (typeof item === "string") {
                            // Look up from existing chain first (preserves prompts), then defaults
                            const existing = targetPath.dataChain.find((d) => d.variableName === item);
                            if (existing) {
                                const dp = buildDataPointsFromChain({ ...targetPath, dataChain: [existing] }, defaults)[0];
                                // Apply branch conditions if specified
                                const bc = pathChanges.branchConditions?.[item];
                                if (bc === null)
                                    delete dp._branchConditions;
                                else if (Array.isArray(bc))
                                    dp._branchConditions = bc;
                                newDataPoints.push(dp);
                            }
                            else {
                                try {
                                    const resolved_dps = resolveDataPoints([item], defaults);
                                    const dp = resolved_dps[0];
                                    const bc = pathChanges.branchConditions?.[item];
                                    if (Array.isArray(bc))
                                        dp._branchConditions = bc;
                                    newDataPoints.push(dp);
                                }
                                catch {
                                    res.status(400).json({ error: `Unknown data point "${item}" in path "${pathName}"` });
                                    return;
                                }
                            }
                        }
                    }
                    const result = regenerateDataChain(targetPath, newDataPoints, closeNodeId, targetPath.name === "Default" ? undefined : targetPath.name);
                    applyRegeneratedChain(canonical, result);
                }
            }
        }
        // Create new paths
        if (Array.isArray(changes.newPaths)) {
            const closeNodeId = parsed.closeNode?.id;
            if (!closeNodeId) {
                res.status(500).json({ error: "Could not find Close node" });
                return;
            }
            const introNode = nodes.find((n) => n.id === parsed.introNode.id);
            const introEdges = introNode.edges;
            const existingPathCount = parsed.paths.length;
            for (let npIdx = 0; npIdx < changes.newPaths.length; npIdx++) {
                const np = changes.newPaths[npIdx];
                if (!np.name || !np.transitionCondition || !Array.isArray(np.dataPointKeys) || np.dataPointKeys.length === 0) {
                    res.status(400).json({ error: "New path requires name, transitionCondition, and dataPointKeys (non-empty)" });
                    return;
                }
                const newDataPoints = [];
                for (const key of np.dataPointKeys) {
                    try {
                        const rdp = resolveDataPoints([key], defaults);
                        newDataPoints.push(rdp[0]);
                    }
                    catch {
                        res.status(400).json({ error: `Unknown data point "${key}" in new path "${np.name}"` });
                        return;
                    }
                }
                const f = makeIdFactory();
                const pathIds = {
                    transitionId: f.nodeId(),
                    frontExtractId: f.nodeId(),
                    routerId: f.nodeId(),
                    chain: newDataPoints.map(() => ({ convId: f.nodeId(), confirmId: f.nodeId() })),
                };
                const pathYBase = (existingPathCount + npIdx) * 2000;
                const pathPos = {
                    transition: { x: -18, y: -400 + pathYBase },
                    frontExtract: { x: -18, y: 0 + pathYBase },
                    router: { x: -18, y: 450 + pathYBase },
                    chain: newDataPoints.map((_, i) => ({
                        conv: { x: -954 + i * 550, y: 900 + pathYBase },
                        confirm: { x: -954 + i * 550, y: 1350 + pathYBase },
                    })),
                };
                nodes.push(buildTransitionNode(pathIds, pathPos, f, np.name));
                nodes.push(...buildDataChain(newDataPoints, pathIds, pathPos, closeNodeId, f, np.name));
                introEdges.push({
                    destination_node_id: pathIds.transitionId,
                    id: f.edgeId(),
                    transition_condition: { type: "prompt", prompt: np.transitionCondition },
                });
            }
        }
        // Validate
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        // Push to Retell
        await pushFlowToRetell(retell(), snapshot.conversationFlowId, canonical);
        await storeCanonical(slug, agentId, canonical, resolved.doc);
        await logAudit(req, "save_and_publish", `${slug}/${agentId}`, {
            description: changes.description,
        });
        res.json({ success: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] save-and-publish error:`, msg);
        res.status(500).json({ error: msg });
    }
});
// ── POST /:agentId/push — Raw JSON Push (admin/root only) ───────────────────
nodeEditorRouter.post("/:agentId/push", requireRoot, async (req, res) => {
    const p = req.params;
    const slug = p.slug;
    const agentId = p.agentId;
    const canonicalJson = req.body.canonicalJson;
    const description = req.body.description;
    if (!canonicalJson || typeof canonicalJson !== "object") {
        res.status(400).json({ error: "canonicalJson object is required" });
        return;
    }
    const resolved = await resolveAgentId(slug, agentId);
    if (!resolved) {
        res.status(404).json({ error: "Agent not found" });
        return;
    }
    try {
        // Validate
        const flow = canonicalJson.conversationFlow;
        if (!flow) {
            res.status(400).json({ error: "canonicalJson must contain conversationFlow" });
            return;
        }
        const errors = validateConversationFlow(flow);
        if (errors.length > 0) {
            res.status(400).json({ error: "Validation failed", errors });
            return;
        }
        // Snapshot current state
        const currentSnapshot = await pullLatest(agentId);
        await createVersionSnapshot(slug, agentId, currentSnapshot.canonicalJson, "manual_edit", `Pre-push snapshot (before raw JSON push)`, req.user?.username ?? "unknown");
        // Push to Retell
        await pushFlowToRetell(retell(), currentSnapshot.conversationFlowId, canonicalJson);
        // Fetch fresh state and store
        const fresh = await pullLatest(agentId);
        await storeCanonical(slug, agentId, fresh.canonicalJson, resolved.doc);
        await createVersionSnapshot(slug, agentId, fresh.canonicalJson, "manual_edit", description || "Raw JSON push", req.user?.username ?? "unknown");
        await logAudit(req, "push_raw_json", `${slug}/${agentId}`, { description });
        res.json({ success: true });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[node-editor] push error:`, msg);
        res.status(500).json({ error: msg });
    }
});
