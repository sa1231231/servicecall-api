// One-shot read-only inspection of Demo HVAC. Surfaces:
//   - The stored client doc's name / display_name / agent_id
//   - The full intro node's instruction text from the canonical Retell flow
//   - The HVAC client's path configs (paths + dataPoints) so we can see
//     whether problem_description is a bare string or an object override
//   - The workspace defaults for problem_description and collect_email,
//     including their finetuneExamples arrays
//
// Read-only — no writes. Output JSON to stdout for piping / inspection.
//
// Run:
//   railway run npx tsx tools/inspect-demo-hvac.ts
//   railway run npx tsx tools/inspect-demo-hvac.ts --slug=demo-hvac2

import "dotenv/config";
import { initDb, getDb } from "../src/lib/db.js";
import { getClientDocument } from "../src/config/client-store.js";
import { getDataPointDefaults } from "../src/lib/data-point-defaults.js";

function parseArg(flag: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : null;
}

async function main() {
  const slug = parseArg("slug") ?? "demo-hvac2";

  await initDb();

  const doc = await getClientDocument(slug);
  if (!doc) {
    console.error(JSON.stringify({ error: `No client doc found for slug=${slug}` }));
    process.exit(1);
  }

  // Pull canonical flow stored under retell_agents (keyed by agent_id).
  const agentId = doc.agent_id;
  const canonical = (doc as any).retell_agents?.[agentId] ?? null;
  const flow = canonical?.conversationFlow ?? null;
  const nodes: Array<Record<string, any>> = flow?.nodes ?? [];
  const startNodeId = flow?.start_node_id;
  const introNode = nodes.find((n) => n.id === startNodeId);
  const introText = introNode?.instruction?.text ?? null;

  // List Retell agent ids associated with this client (for context if
  // multiple agents share a client doc).
  const retellAgentIds = Object.keys((doc as any).retell_agents ?? {});

  // Pull workspace defaults for the two DPs in question.
  const defaults = await getDataPointDefaults();
  const problemDescription = defaults["problem_description"] ?? null;
  const collectEmail = defaults["collect_email"] ?? null;

  // Try to extract per-path config from the canonical flow. The parser
  // would do this more robustly, but we want raw shape — surface each
  // path's collect nodes so we can see how problem_description is wired.
  const collectNodes = nodes.filter(
    (n) => typeof n.name === "string" && n.name.startsWith("Collect "),
  );
  const collectSummary = collectNodes.map((n) => ({
    id: n.id,
    name: n.name,
    finetune_count: Array.isArray(n.finetune_transition_examples)
      ? n.finetune_transition_examples.length
      : 0,
    finetune_transcripts:
      (n.finetune_transition_examples ?? []).map((ex: any) => {
        const utter = ex.transcript?.find((t: any) => t.role === "user")?.content;
        return utter ?? "(no user utterance)";
      }),
  }));

  // Look for the problem_description variable on the confirm extract nodes.
  // This tells us whether the DP made it into the agent at all.
  const extractNodes = nodes.filter((n) => n.type === "extract_dynamic_variables");
  const problemDescPresence = extractNodes
    .filter((n) =>
      Array.isArray(n.variables) &&
      n.variables.some((v: any) => v.name === "problem_description"),
    )
    .map((n) => ({ id: n.id, name: n.name }));

  // ── Step-1 diagnostics for the dp-reversal bug ────────────────────────────
  //
  // Dump three things so we can pin the cause of the "node editor shows
  // dataPoints reversed" report:
  //
  //   1. The front Extract All Variables node's variables[] (source order
  //      as written by the generator).
  //   2. Every Variables Router node's edges[] destination ids, mapped to
  //      the names of the nodes they point at, in the order Retell returned
  //      them. If this is reversed vs (1), Retell is flipping the array
  //      on fetch.
  //   3. The HVAC Default draft (agent_drafts collection) — both
  //      formData.routingPaths[i].chain (form authoring shape) and
  //      exportConfig.paths[i].dataPoints (create-time payload) — so we
  //      can tell whether the draft itself is stored reversed.
  const nodesById = new Map<string, Record<string, any>>(nodes.map((n) => [n.id as string, n]));
  const labelFor = (nodeId: string | undefined): string => {
    if (!nodeId) return "(none)";
    const n = nodesById.get(nodeId);
    if (!n) return `(missing:${nodeId})`;
    return `${n.name ?? "?"} [${n.type ?? "?"}]`;
  };

  const frontExtract = nodes.find(
    (n) => n.type === "extract_dynamic_variables" && n.name === "Extract All Variables",
  );
  const frontExtractVars = Array.isArray(frontExtract?.variables)
    ? frontExtract!.variables.map((v: any) => v.name)
    : [];

  const routerNodes = nodes.filter((n) => /Variables Router/i.test(n.name ?? ""));
  const routerSummary = routerNodes.map((r) => ({
    id: r.id,
    name: r.name,
    edges: Array.isArray(r.edges)
      ? r.edges.map((e: any) => ({
          destination_node_id: e.destination_node_id,
          dest: labelFor(e.destination_node_id),
        }))
      : null,
    else_edge_dest: labelFor(r.else_edge?.destination_node_id),
  }));

  // Pull the HVAC Default draft so we can compare its stored chain order
  // against the live agent's router/front-extract order.
  const draftDoc: any = await getDb()
    .collection("agent_drafts")
    .find({ name: "HVAC Default" })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  const draftSummary = draftDoc
    ? {
        _id: String(draftDoc._id),
        name: draftDoc.name,
        updatedAt: draftDoc.updatedAt,
        formData_routingPaths: (draftDoc.formData?.routingPaths ?? []).map(
          (p: any) => ({
            name: p.name,
            chain: Array.isArray(p.chain)
              ? p.chain.map((c: any) =>
                  typeof c === "string"
                    ? c
                    : c?._ref ?? c?.variableName ?? c?._custom ? `<custom:${c?.variableName ?? "?"}>` : "?",
                )
              : null,
          }),
        ),
        exportConfig_paths: (draftDoc.exportConfig?.paths ?? []).map(
          (p: any) => ({
            name: p.name,
            dataPoints: Array.isArray(p.dataPoints)
              ? p.dataPoints.map((dp: any) =>
                  typeof dp === "string" ? dp : dp?.variableName ?? "?",
                )
              : null,
          }),
        ),
      }
    : null;

  const report = {
    slug,
    client_name: doc.name,
    client_display_name: doc.display_name ?? null,
    agent_id: doc.agent_id,
    retell_agent_ids: retellAgentIds,
    intro: {
      node_id: introNode?.id ?? null,
      instruction_text: introText,
      polluted: typeof introText === "string" && /TEMP-\d+/.test(introText),
    },
    collect_nodes: collectSummary,
    problem_description_extract_nodes: problemDescPresence,
    // Step-1 diagnostics for the data-point reversal bug.
    front_extract_variables: frontExtractVars,
    routers: routerSummary,
    hvac_default_draft: draftSummary,
    workspace_defaults: {
      problem_description: problemDescription
        ? {
            label: problemDescription.label,
            variableName: problemDescription.variableName,
            type: problemDescription.type,
            choices: problemDescription.choices ?? null,
            finetune_count: (problemDescription.finetuneExamples ?? []).length,
            finetune_examples: (problemDescription.finetuneExamples ?? []).map((ex: any) => ({
              type: ex.type,
              first_user_utterance: ex.transcript?.find((t: any) => t.role === "user")?.content ?? null,
            })),
          }
        : null,
      collect_email: collectEmail
        ? {
            label: collectEmail.label,
            variableName: collectEmail.variableName,
            type: collectEmail.type,
            finetune_count: (collectEmail.finetuneExamples ?? []).length,
            finetune_examples: (collectEmail.finetuneExamples ?? []).map((ex: any) => ({
              type: ex.type,
              first_user_utterance: ex.transcript?.find((t: any) => t.role === "user")?.content ?? null,
            })),
          }
        : null,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("inspect-demo-hvac failed:", err?.stack ?? err);
    process.exit(1);
  });
