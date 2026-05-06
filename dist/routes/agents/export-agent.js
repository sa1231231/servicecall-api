import { getClientDocument } from "../../config/client-store.js";
import { parseConversationFlow } from "../../lib/node-parser.js";
/**
 * Export an agent config as a JSON file compatible with POST /agents/create.
 * Reconstructs the create-body format from the stored canonical JSON.
 */
export async function exportAgentHandler(req, res) {
    const slug = String(req.params.slug);
    const doc = await getClientDocument(slug);
    if (!doc) {
        res.status(404).json({ error: `Client "${slug}" not found` });
        return;
    }
    const agentId = doc.agent_id;
    if (!agentId) {
        res.status(400).json({ error: "No agent_id found for this client" });
        return;
    }
    const canonical = doc.retell_agents?.[agentId];
    if (!canonical) {
        res.status(400).json({ error: "No canonical JSON found for this agent" });
        return;
    }
    try {
        const parsed = parseConversationFlow(canonical);
        // Extract FAQ from the FAQ node
        let faqKnowledgeBase = "";
        if (parsed.faqNode) {
            const instr = parsed.faqNode.raw.instruction;
            const fullText = instr?.text ?? "";
            const faqPrefix = "Your goal is to answer administrative and general questions briefly and accurately.\n\n";
            faqKnowledgeBase = fullText.startsWith(faqPrefix)
                ? fullText.slice(faqPrefix.length)
                : fullText;
        }
        // Detect human request mode (caller-asks-for-human path).
        // Per-path end mode (callback vs transfer at end-of-flow) is read from
        // each ParsedPath.endMode below; the global "Transfer Call" node is the
        // human-request transfer node, distinct from per-path "Transfer Call (X)".
        const hasGlobalTransferCall = parsed.allNodes.some((n) => n.name === "Transfer Call");
        const humanRequestMode = hasGlobalTransferCall ? "live_transfer" : "callback";
        // Extract closing-prompt text from the canonical's closing-sequence nodes.
        // Closing Remarks and Closing Statement are global. Close is per-path on
        // multi-path agents (one "Close (pathName)" per callback path) and a
        // singleton "Close" on single-path agents.
        function findInstructionText(nodeName) {
            const node = parsed.allNodes.find((n) => n.name === nodeName);
            const instr = node?.raw.instruction;
            const text = instr?.text;
            return text && text.length > 0 ? text : undefined;
        }
        // Per-path close map from each path's discovered closeNode (parser walks
        // the Variables Router else_edge to find each path's terminal Close).
        const pathClosePrompts = {};
        for (const pp of parsed.paths) {
            if (pp.endMode !== "callback")
                continue;
            const text = pp.closePrompt;
            if (text && text.length > 0)
                pathClosePrompts[pp.name] = text;
        }
        // Legacy single closePrompt: emitted when there's a singleton "Close" node
        // (single-path agents). For multi-path agents the per-path map above is
        // the source of truth and the singleton field is omitted.
        const closePrompt = findInstructionText("Close");
        const closingRemarksPrompt = findInstructionText("Closing Remarks");
        const closingStatementText = findInstructionText("Closing Statement");
        // Live Transfer Recovery — only present on agents that have at least one
        // transfer-mode path (or live-transfer human-request mode). Spoken when
        // a transfer fails to bridge. Falls back to the legacy "Transfer Failed"
        // name for agents created before the rename.
        const liveTransferRecoveryPrompt = findInstructionText("Live Transfer Recovery") ?? findInstructionText("Transfer Failed");
        // Extract transition conditions from intro edges
        const introEdges = parsed.introNode.raw.edges;
        // Build paths with data points
        const paths = parsed.paths.map((path) => {
            // Find transition condition
            let transitionCondition = "";
            if (Array.isArray(introEdges)) {
                const edge = introEdges.find((e) => e.destination_node_id === path.transitionNode.id);
                if (edge) {
                    const tc = edge.transition_condition;
                    transitionCondition = tc?.prompt ?? "";
                }
            }
            // Extract branch conditions from router edges to reconstruct branch structure
            const routerEdges = path.routerNode.raw.edges;
            // Build data points — try to use registry keys where possible, inline for custom
            const dataPoints = [];
            for (const dp of path.dataChain) {
                // Check for branch conditions
                let branchConditions;
                if (Array.isArray(routerEdges)) {
                    const edge = routerEdges.find((e) => e.destination_node_id === dp.collectNode.id);
                    if (edge) {
                        const tc = edge.transition_condition;
                        if (tc?.type === "equation") {
                            const eqs = tc.equations;
                            if (Array.isArray(eqs)) {
                                const meaningful = eqs.filter((eq) => {
                                    const left = eq.left;
                                    const val = eq.right;
                                    // Filter out "is missing" checks and sentinel guards
                                    if (left === `{{${dp.variableName}}}`)
                                        return false;
                                    if (left === `{{phone_number_collected}}`)
                                        return false;
                                    if (dp.variableDefs.some((v) => left === `{{${v.name}}}`))
                                        return false;
                                    if (val === "Not Mentioned" || val === "Caller Doesn't Know")
                                        return false;
                                    return true;
                                });
                                if (meaningful.length > 0) {
                                    branchConditions = meaningful.map((eq) => ({
                                        variable: eq.left.replace(/^\{\{|\}\}$/g, ""),
                                        operator: eq.operator,
                                        value: eq.right,
                                    }));
                                }
                            }
                        }
                    }
                }
                // Build data point entry
                const varDef = dp.variableDefs[0];
                const dpEntry = {
                    variableName: dp.variableName,
                    label: dp.label,
                    type: varDef?.type ?? "string",
                    description: varDef?.description ?? "",
                    conversationPrompt: dp.conversationPrompt,
                    forwardCondition: dp.forwardCondition,
                };
                if (varDef?.choices)
                    dpEntry.choices = varDef.choices;
                if (dp.orphan)
                    dpEntry.orphan = true;
                if (branchConditions)
                    dpEntry._branchConditions = branchConditions;
                dataPoints.push(dpEntry);
            }
            return {
                name: path.name,
                transitionCondition,
                dataPoints,
                end_mode: path.endMode,
            };
        });
        // Build the export config
        const config = {
            version: 1,
            type: "servicecall-agent-config",
            exportedAt: new Date().toISOString(),
            exportedFrom: { slug, agentId },
            business: {
                businessName: canonical.agent_name ?? doc.name,
                faqKnowledgeBase,
                introFinetuneExamples: [],
                human_request_mode: humanRequestMode,
                // Closing prompts (omitted if the node text is empty so that import
                // falls back to defaults rather than persisting an empty string).
                // Per-path close prompts win on multi-path agents; the legacy single
                // closePrompt is emitted only when no per-path map was found (single-
                // path layouts) so older importers keep working.
                ...(Object.keys(pathClosePrompts).length > 0
                    ? { pathClosePrompts }
                    : (closePrompt !== undefined ? { closePrompt } : {})),
                ...(closingRemarksPrompt !== undefined ? { closingRemarksPrompt } : {}),
                ...(closingStatementText !== undefined ? { closingStatementText } : {}),
                ...(liveTransferRecoveryPrompt !== undefined ? { liveTransferRecoveryPrompt } : {}),
            },
            paths,
            client: {
                slug,
                name: doc.name,
                dispatch_text_numbers: doc.dispatch_text_numbers ?? [],
                dispatch_call_number: doc.dispatch_call_number ?? null,
                dispatch_call_overrides: doc.dispatch_call_overrides ?? undefined,
                dispatch_email: doc.dispatch_email ?? null,
                dispatch_cc: doc.dispatch_cc ?? null,
                dispatch_by_type: doc.dispatch_by_type ?? undefined,
                path_end_modes: doc.path_end_modes ?? undefined,
                summary_agent_id: doc.summary_agent_id ?? null,
                outbound_from_number: doc.outbound_from_number ?? null,
                webhook_url: doc.webhook_url ?? undefined,
                notification_greeting: doc.notification_greeting ?? undefined,
                weekly_report_enabled: doc.weekly_report_enabled ?? undefined,
                shadow_mode: doc.shadow_mode ?? false,
                hide_not_mentioned: doc.hide_not_mentioned ?? false,
                phone_fallback_to_caller: doc.phone_fallback_to_caller ?? true,
            },
        };
        // Set download headers
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${slug}-config.json"`);
        res.json(config);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[export-agent] error:`, msg);
        res.status(500).json({ error: msg });
    }
}
