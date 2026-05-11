// One-shot migration: insert the "Close Question" node into every existing
// agent's canonical conversation flow (commit 72f2e86 added it to the
// generator going forward; this script retro-fits live agents).
//
// New chain:
//   Close (per-path or singleton)
//     → always_edge → Close Question ("anything else?")
//     → edge "no more questions" → Closing Remarks
//
// Idempotent: re-running this skips any agent whose flow already has a node
// named "Close Question". A run that crashes mid-way can be re-run safely.
//
// Run:
//   tsx tools/migrate-add-close-question.ts            # dry-run (default)
//   tsx tools/migrate-add-close-question.ts --apply    # write to Mongo + Retell
//   tsx tools/migrate-add-close-question.ts --apply --limit=3
//   tsx tools/migrate-add-close-question.ts --apply --slug=demo-meter
//
// Env: MONGODB_URL + RETELL_API_KEY (same as the API uses).

import "dotenv/config";
import Retell from "retell-sdk";
import { config } from "../src/config.js";
import { initDb, getDb } from "../src/lib/db.js";
import { pushFlowToRetell } from "../src/lib/retell-sync.js";
import { DEFAULT_CLOSE_QUESTION_PROMPT } from "../src/lib/agent-generator/node-builders.js";

const APPLY = process.argv.includes("--apply");
const SLUG_FLAG = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];
const LIMIT_FLAG = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = LIMIT_FLAG ? Math.max(1, Number(LIMIT_FLAG)) : undefined;

interface ClientDoc {
  _id: string;
  name?: string;
  retell_agents?: Record<string, Record<string, unknown>>;
}

interface Node {
  id: string;
  name: string;
  type: string;
  instruction?: { type?: string; text?: string };
  always_edge?: { destination_node_id: string; id: string; transition_condition?: unknown };
  edges?: Array<{ destination_node_id: string; id: string; transition_condition?: unknown }>;
  display_position?: { x: number; y: number };
  [k: string]: unknown;
}

function randomSuffix(len: number): string {
  return Math.random().toString(36).slice(2, 2 + len).padEnd(len, "0");
}

function nowStamp(offset = 0): number {
  return Date.now() + offset;
}

// ── Migration ───────────────────────────────────────────────────────────────

interface MigrationResult {
  slug: string;
  agentId: string;
  status: "migrated" | "skipped-already" | "skipped-no-close" | "skipped-no-remarks" | "error";
  detail?: string;
}

function migrateOneFlow(
  canonical: Record<string, unknown>,
): { changed: boolean; reason: string; closeNodes?: number } {
  const flow = canonical.conversationFlow as Record<string, unknown> | undefined;
  if (!flow) return { changed: false, reason: "no conversationFlow" };
  const nodes = flow.nodes as Node[] | undefined;
  if (!Array.isArray(nodes)) return { changed: false, reason: "no nodes array" };

  // Idempotency: bail if a Close Question already exists.
  if (nodes.some((n) => n.name === "Close Question")) {
    return { changed: false, reason: "skipped-already" };
  }

  // Find all Close nodes (singleton "Close" OR per-path "Close (pathName)").
  const closeNodes = nodes.filter(
    (n) => n.name === "Close" || n.name.startsWith("Close ("),
  );
  if (closeNodes.length === 0) {
    return { changed: false, reason: "skipped-no-close" };
  }

  // Find the Closing Remarks node (the previous always_edge target).
  const closingRemarks = nodes.find((n) => n.name === "Closing Remarks");
  if (!closingRemarks) {
    return { changed: false, reason: "skipped-no-remarks" };
  }

  // Pull the business_name token from any existing closing prompt so the
  // new node's default text matches the agent's templating habit. The
  // node-builders default already uses "Is there anything else I can help
  // you with?" verbatim — render that as static text. If the operator wants
  // {{business_name}} interpolation later they can edit the prompt in the
  // dashboard.
  const newNodeId = `node-${nowStamp(1)}`;
  const newEdgeId = `edge-${nowStamp(2)}-${randomSuffix(9)}`;
  // Visual position: a column down from the existing Close node's x, halfway
  // between Close and Closing Remarks vertically. Falls back to the
  // Closing Remarks position offset upward when Close has no display_position.
  const referenceClose = closeNodes[0];
  const baseX =
    referenceClose.display_position?.x ?? closingRemarks.display_position?.x ?? 0;
  const refY = referenceClose.display_position?.y ?? 894;
  const newPos = { x: baseX, y: refY + 144 };

  const closeQuestionNode: Node = {
    id: newNodeId,
    name: "Close Question",
    type: "conversation",
    instruction: {
      type: "prompt",
      text: DEFAULT_CLOSE_QUESTION_PROMPT,
    },
    edges: [
      {
        destination_node_id: closingRemarks.id,
        id: newEdgeId,
        transition_condition: {
          type: "prompt",
          prompt: "The caller has no more questions",
        },
      },
    ],
    display_position: newPos,
  };

  // Repoint every Close node's always_edge to the new Close Question node.
  for (const closeNode of closeNodes) {
    if (!closeNode.always_edge) continue;
    closeNode.always_edge.destination_node_id = newNodeId;
  }

  // Insert the new node right after the first Close in the array — purely
  // cosmetic ordering for readability when inspecting the JSON; flows are
  // routed by edges, not array order.
  const firstCloseIdx = nodes.indexOf(referenceClose);
  if (firstCloseIdx >= 0) {
    nodes.splice(firstCloseIdx + 1, 0, closeQuestionNode);
  } else {
    nodes.push(closeQuestionNode);
  }

  return { changed: true, reason: "migrated", closeNodes: closeNodes.length };
}

async function main(): Promise<void> {
  if (!APPLY) {
    console.log("=== DRY RUN === (pass --apply to write changes)");
  } else {
    console.log("=== APPLY MODE === (writing to Mongo + Retell)");
  }
  if (SLUG_FLAG) console.log(`Slug filter: ${SLUG_FLAG}`);
  if (LIMIT) console.log(`Limit: ${LIMIT}`);

  await initDb();
  const db = getDb();
  const retell = new Retell({ apiKey: config.RETELL_API_KEY });

  const filter: Record<string, unknown> = { retell_agents: { $exists: true } };
  if (SLUG_FLAG) filter._id = SLUG_FLAG;

  const clients = await db.collection<ClientDoc>("clients").find(filter).toArray();
  console.log(`Found ${clients.length} client(s) with retell_agents.`);

  const results: MigrationResult[] = [];
  let agentsTouched = 0;

  outer: for (const client of clients) {
    const agents = client.retell_agents ?? {};
    for (const [agentId, canonical] of Object.entries(agents)) {
      if (LIMIT && agentsTouched >= LIMIT) break outer;

      // Shallow-clone the canonical so a dry-run mutation doesn't poison the
      // doc in memory across iterations. Apply mode mutates in place and
      // writes back via $set.
      const draft = JSON.parse(JSON.stringify(canonical)) as Record<string, unknown>;
      const outcome = migrateOneFlow(draft);

      const flow = draft.conversationFlow as Record<string, unknown> | undefined;
      const flowId = (flow?.conversation_flow_id as string) ?? "";
      const agentName = (draft.agent_name as string) ?? client.name ?? client._id;

      if (!outcome.changed) {
        results.push({
          slug: client._id,
          agentId,
          status: outcome.reason as MigrationResult["status"],
        });
        console.log(`  [${outcome.reason}] ${client._id} / ${agentName} (${agentId})`);
        continue;
      }

      agentsTouched++;
      console.log(
        `  [migrate] ${client._id} / ${agentName} (${agentId})` +
          ` — repointed ${outcome.closeNodes} Close node(s) → new Close Question → Closing Remarks`,
      );

      if (!APPLY) {
        results.push({ slug: client._id, agentId, status: "migrated", detail: "dry-run" });
        continue;
      }

      // Apply: push to Retell first (so a Retell failure doesn't desync Mongo
      // from prod), then update Mongo.
      try {
        if (!flowId) throw new Error("missing conversation_flow_id");
        await pushFlowToRetell(retell, flowId, draft);
        await db.collection<ClientDoc>("clients").updateOne(
          { _id: client._id } as any,
          {
            $set: {
              [`retell_agents.${agentId}`]: draft,
              last_deployed_at: new Date().toISOString(),
            },
            $inc: { _version: 1 } as never,
          },
        );
        results.push({ slug: client._id, agentId, status: "migrated" });
        console.log(`    ✓ pushed to Retell + Mongo (flow ${flowId})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          slug: client._id,
          agentId,
          status: "error",
          detail: msg,
        });
        console.error(`    ✗ ERROR: ${msg}`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const tally: Record<string, number> = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  console.log("\n=== Summary ===");
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
  if (!APPLY) {
    console.log("\nRe-run with --apply to write these changes.");
  } else {
    console.log("\nDone. Errors above (if any) need manual follow-up.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
