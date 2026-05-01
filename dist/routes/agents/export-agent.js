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
    const agentIds = doc.agent_ids ?? [];
    if (agentIds.length === 0) {
        res.status(400).json({ error: "No agent IDs found for this client" });
        return;
    }
    const agentId = agentIds[0];
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
        // Detect human request mode
        const hasTransferCall = parsed.allNodes.some((n) => n.name === "Transfer Call");
        const humanRequestMode = hasTransferCall ? "live_transfer" : "callback";
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
            },
            paths,
            client: {
                slug,
                name: doc.name,
                dispatch_text_numbers: doc.dispatch_text_numbers ?? [],
                dispatch_call_number: doc.dispatch_call_number ?? null,
                dispatch_email: doc.dispatch_email ?? null,
                dispatch_by_type: doc.dispatch_by_type ?? undefined,
                summary_agent_id: doc.summary_agent_id ?? null,
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
