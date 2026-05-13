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
//   railway run npx tsx tools/inspect-demo-hvac.ts --slug=demo-hvac

import "dotenv/config";
import { initDb } from "../src/lib/db.js";
import { getClientDocument } from "../src/config/client-store.js";
import { getDataPointDefaults } from "../src/lib/data-point-defaults.js";

function parseArg(flag: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : null;
}

async function main() {
  const slug = parseArg("slug") ?? "demo-hvac";

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
