import type { Request, Response } from "express";
import { getClientDocument } from "../../config/client-store.js";
import { parseConversationFlow } from "../../lib/node-parser.js";
import type { ParsedDataPoint } from "../../lib/node-parser.js";

/**
 * Export an agent config as a JSON file compatible with POST /agents/create.
 * Reconstructs the create-body format from the stored canonical JSON.
 */
export async function exportAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
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
  const canonical = doc.retell_agents?.[agentId] as Record<string, unknown> | undefined;
  if (!canonical) {
    res.status(400).json({ error: "No canonical JSON found for this agent" });
    return;
  }

  try {
    const parsed = parseConversationFlow(canonical);

    // Extract FAQ from the FAQ node
    let faqKnowledgeBase = "";
    if (parsed.faqNode) {
      const instr = parsed.faqNode.raw.instruction as Record<string, unknown> | undefined;
      const fullText = (instr?.text as string) ?? "";
      const faqPrefix = "Your goal is to answer administrative and general questions briefly and accurately.\n\n";
      faqKnowledgeBase = fullText.startsWith(faqPrefix)
        ? fullText.slice(faqPrefix.length)
        : fullText;
    }

    // Detect human request mode
    const hasTransferCall = parsed.allNodes.some((n) => n.name === "Transfer Call");
    const humanRequestMode = hasTransferCall ? "live_transfer" : "callback";

    // Extract transition conditions from intro edges
    const introEdges = parsed.introNode.raw.edges as Array<Record<string, unknown>> | undefined;

    // Build paths with data points
    const paths = parsed.paths.map((path) => {
      // Find transition condition
      let transitionCondition = "";
      if (Array.isArray(introEdges)) {
        const edge = introEdges.find((e) => e.destination_node_id === path.transitionNode.id);
        if (edge) {
          const tc = edge.transition_condition as Record<string, unknown> | undefined;
          transitionCondition = (tc?.prompt as string) ?? "";
        }
      }

      // Extract branch conditions from router edges to reconstruct branch structure
      const routerEdges = path.routerNode.raw.edges as Array<Record<string, unknown>> | undefined;

      // Build data points — try to use registry keys where possible, inline for custom
      const dataPoints: any[] = [];
      for (const dp of path.dataChain) {
        // Check for branch conditions
        let branchConditions: any[] | undefined;
        if (Array.isArray(routerEdges)) {
          const edge = routerEdges.find((e) => e.destination_node_id === dp.collectNode.id);
          if (edge) {
            const tc = edge.transition_condition as Record<string, unknown> | undefined;
            if (tc?.type === "equation") {
              const eqs = tc.equations as Array<Record<string, unknown>> | undefined;
              if (Array.isArray(eqs)) {
                const meaningful = eqs.filter((eq) => {
                  const left = eq.left as string;
                  const val = eq.right as string | undefined;
                  // Filter out "is missing" checks and sentinel guards
                  if (left === `{{${dp.variableName}}}`) return false;
                  if (left === `{{phone_number_collected}}`) return false;
                  if (dp.variableDefs.some((v) => left === `{{${v.name}}}`)) return false;
                  if (val === "Not Mentioned" || val === "Caller Doesn't Know") return false;
                  return true;
                });
                if (meaningful.length > 0) {
                  branchConditions = meaningful.map((eq) => ({
                    variable: (eq.left as string).replace(/^\{\{|\}\}$/g, ""),
                    operator: eq.operator as string,
                    value: eq.right as string | undefined,
                  }));
                }
              }
            }
          }
        }

        // Build data point entry
        const varDef = dp.variableDefs[0];
        const dpEntry: any = {
          variableName: dp.variableName,
          label: dp.label,
          type: varDef?.type ?? "string",
          description: varDef?.description ?? "",
          conversationPrompt: dp.conversationPrompt,
          forwardCondition: dp.forwardCondition,
        };
        if (varDef?.choices) dpEntry.choices = varDef.choices;
        if (branchConditions) dpEntry._branchConditions = branchConditions;

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
        businessName: (canonical.agent_name as string) ?? doc.name,
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
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${slug}-config.json"`,
    );
    res.json(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[export-agent] error:`, msg);
    res.status(500).json({ error: msg });
  }
}
