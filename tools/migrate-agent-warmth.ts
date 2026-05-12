// One-shot migration: apply Home Heating's warmth-tuned settings as the
// new baseline for existing agents that are still on the OLD generator
// defaults. Mirrors tools/migrate-add-close-question.ts.
//
// Per agent the script loops over and:
//   1. Voice + STT + behavior config (agent root). For each touched field,
//      ONLY update when the current value exactly matches the OLD default.
//      If the operator already customized the field (e.g. picked a
//      different voice_id), leave it alone.
//   2. Handbook flags. Flip false → true on the three warmth flags
//      (default_personality, natural_filler_words, high_empathy) only
//      when currently false.
//   3. Global prompt. Only update when the agent's current global_prompt
//      contains the OLD verbatim phrasing of each edited section.
//      Operator-customized prompts are logged as "skipped-customized".
//
// Pushes are split:
//   - Voice / STT / handbook → retell.agent.update(agent_id, {...})
//   - global_prompt + transition nodes → retell.conversationFlow.update(flow_id, {...})
//     via pushFlowToRetell()
//
// Idempotent by construction (all the "only if matches old default"
// guards). Dry-run by default; --apply to commit.
//
// Run:
//   railway run npx tsx tools/migrate-agent-warmth.ts            # dry run
//   railway run npx tsx tools/migrate-agent-warmth.ts --slug=demo-meter --apply
//   railway run npx tsx tools/migrate-agent-warmth.ts --apply
//   railway run npx tsx tools/migrate-agent-warmth.ts --apply --component=voice
//
// Env: MONGODB_URL + RETELL_API_KEY (same as the prior migration script).

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import Retell from "retell-sdk";
import { config } from "../src/config.js";
import { initDb, getDb } from "../src/lib/db.js";
import { pushFlowToRetell } from "../src/lib/retell-sync.js";

// ── Old vs new values ──────────────────────────────────────────────────────
//
// The script keys all "should we update?" decisions off these tables. To
// extend the migration with a new field, add a row here AND a check in
// computeAgentRootUpdates() / computeGlobalPromptUpdates().

const OLD_AGENT_ROOT_VALUES = {
  voice_id: "11labs-Ethan",
  voice_temperature: 0.44,
  voice_speed: 1.02,
  ambient_sound_volume: 0.95,
  interruption_sensitivity: 0.89,
  allow_user_dtmf: false,
  // custom_stt_config is nested; handled separately below.
} as const;

const NEW_AGENT_ROOT_VALUES = {
  voice_id: "11labs-Billy",
  voice_temperature: 0.98,
  voice_speed: 0.98,
  ambient_sound_volume: 0.86,
  interruption_sensitivity: 0.84,
  allow_user_dtmf: true,
} as const;

const OLD_STT_ENDPOINTING_MS = 1200;
const NEW_STT_ENDPOINTING_MS = 1540;

const WARMTH_HANDBOOK_FLAGS = [
  "default_personality",
  "natural_filler_words",
  "high_empathy",
] as const;

const OLD_GLOBAL_PROMPT_NAME_RULE_LINE =
  "Once you know the caller's first name, use it in the opening and ending of the call, nowhere else.";

const OLD_GLOBAL_PROMPT_ACK_INTRO =
  "Acknowledge by using the available short acknowledgments listed here:";

const NEW_GLOBAL_PROMPT_ACK_INTRO =
  "When appropriate to acknowledge, only use short acknowledgments such as:";

const OLD_TRANSITION_INSTRUCTION =
  `The caller stated their situation, and you're about to note down the details. You can say something like

"alright let me grab the information"

Do not ask any questions here.`;

const NEW_TRANSITION_INSTRUCTION =
  `Empathetically acknowledge the caller's situation, then say something like

"let me grab the information"

Do not ask any questions here.`;

// ── CLI ────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const SLUG_FLAG = process.argv.find((a) => a.startsWith("--slug="))?.split("=")[1];
const LIMIT_FLAG = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = LIMIT_FLAG ? Math.max(1, Number(LIMIT_FLAG)) : undefined;
const COMPONENT_FLAG = process.argv.find((a) => a.startsWith("--component="))?.split("=")[1];

type Component = "voice" | "handbook" | "prompt" | "transition";
function isComponent(s: string | undefined): s is Component {
  return s === "voice" || s === "handbook" || s === "prompt" || s === "transition";
}
const COMPONENT_FILTER: Component | "all" = isComponent(COMPONENT_FLAG) ? COMPONENT_FLAG : "all";

// ── Decision logic (exported for unit tests) ───────────────────────────────

export interface AgentRootUpdates {
  /** Patch to send to retell.agent.update. Empty when no fields qualify. */
  patch: Record<string, unknown>;
  /** Per-field summary for logging. */
  decisions: Array<{ field: string; from: unknown; to: unknown; kept?: boolean }>;
}

/**
 * Decide which voice / STT / DTMF fields should update for a given agent
 * snapshot. Only updates fields that exactly match the OLD default —
 * customized values are preserved verbatim.
 */
export function computeAgentRootUpdates(
  current: Record<string, unknown>,
): AgentRootUpdates {
  const patch: Record<string, unknown> = {};
  const decisions: AgentRootUpdates["decisions"] = [];

  for (const key of Object.keys(OLD_AGENT_ROOT_VALUES) as Array<keyof typeof OLD_AGENT_ROOT_VALUES>) {
    const cur = current[key];
    const oldDefault = OLD_AGENT_ROOT_VALUES[key];
    const newDefault = NEW_AGENT_ROOT_VALUES[key];
    if (cur === oldDefault) {
      patch[key] = newDefault;
      decisions.push({ field: key, from: cur, to: newDefault });
    } else if (cur === newDefault) {
      // Already migrated — nothing to do, don't log noise.
    } else {
      decisions.push({ field: key, from: cur, to: newDefault, kept: true });
    }
  }

  // custom_stt_config.endpointing_ms (nested). Only update when the rest of
  // the STT config looks like the default shape.
  const stt = current.custom_stt_config as
    | { provider?: string; endpointing_ms?: number }
    | undefined;
  if (stt && stt.provider === "deepgram") {
    if (stt.endpointing_ms === OLD_STT_ENDPOINTING_MS) {
      patch.custom_stt_config = {
        ...stt,
        endpointing_ms: NEW_STT_ENDPOINTING_MS,
      };
      decisions.push({
        field: "custom_stt_config.endpointing_ms",
        from: OLD_STT_ENDPOINTING_MS,
        to: NEW_STT_ENDPOINTING_MS,
      });
    } else if (stt.endpointing_ms !== NEW_STT_ENDPOINTING_MS) {
      // Operator-customized — log + skip.
      decisions.push({
        field: "custom_stt_config.endpointing_ms",
        from: stt.endpointing_ms,
        to: NEW_STT_ENDPOINTING_MS,
        kept: true,
      });
    }
    // else: already at new value — silent.
  }
  // else: non-deepgram provider — leave alone, silent (operator made
  // a deliberate STT-provider choice we shouldn't touch).

  return { patch, decisions };
}

export interface HandbookUpdates {
  patch: { handbook_config: Record<string, unknown> } | Record<string, never>;
  decisions: Array<{ flag: string; from: boolean | undefined; to: boolean; kept?: boolean }>;
}

/** Decide which handbook flags to flip on. Only flips false → true; never
 *  overwrites a flag the operator deliberately set true elsewhere. */
export function computeHandbookUpdates(
  current: Record<string, unknown>,
): HandbookUpdates {
  const hb = (current.handbook_config as Record<string, boolean> | undefined) ?? {};
  const flipped: Record<string, boolean> = {};
  const decisions: HandbookUpdates["decisions"] = [];

  for (const flag of WARMTH_HANDBOOK_FLAGS) {
    const cur = hb[flag];
    if (cur === true) {
      // Already at target — silent. Whether the operator put it there or
      // a previous migration run did, there's nothing to say in dry-run.
      continue;
    }
    if (cur === false) {
      flipped[flag] = true;
      decisions.push({ flag, from: false, to: true });
    } else {
      // Missing or non-boolean — log + skip (operator should review).
      decisions.push({ flag, from: cur, to: true, kept: true });
    }
  }

  if (Object.keys(flipped).length === 0) {
    return { patch: {}, decisions };
  }

  return {
    patch: { handbook_config: { ...hb, ...flipped } },
    decisions,
  };
}

export interface GlobalPromptUpdate {
  /** New prompt string, or null if no update applicable. */
  newPrompt: string | null;
  /** Reasons for the decision — for logging. */
  notes: string[];
}

/**
 * Surgically edit two known phrases out of an agent's global prompt. Only
 * applies the edit when the OLD verbatim phrasing is present. Operator-
 * customized prompts produce { newPrompt: null }.
 */
export function computeGlobalPromptUpdate(
  current: string | undefined,
): GlobalPromptUpdate {
  const notes: string[] = [];
  if (typeof current !== "string" || current.length === 0) {
    notes.push("no global_prompt — skipping");
    return { newPrompt: null, notes };
  }
  let next = current;

  if (current.includes(OLD_GLOBAL_PROMPT_NAME_RULE_LINE)) {
    // Remove the line plus any leading/trailing blank line so we don't
    // leave a double-blank.
    next = next.replace(
      new RegExp(`\\n?${escapeForRegExp(OLD_GLOBAL_PROMPT_NAME_RULE_LINE)}\\n?`),
      "\n",
    );
    notes.push("removed first-name rule");
  } else {
    notes.push("first-name rule already absent — skipping line edit");
  }

  if (current.includes(OLD_GLOBAL_PROMPT_ACK_INTRO)) {
    next = next.replace(OLD_GLOBAL_PROMPT_ACK_INTRO, NEW_GLOBAL_PROMPT_ACK_INTRO);
    notes.push("softened acknowledgment-list intro");
  } else {
    notes.push("acknowledgment intro already updated — skipping");
  }

  if (next === current) {
    return { newPrompt: null, notes };
  }
  // Collapse any triple-newlines created by the line removal.
  next = next.replace(/\n{3,}/g, "\n\n");
  return { newPrompt: next, notes };
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface TransitionNodeUpdate {
  /** Node ids whose instruction.text was rewritten. */
  rewrittenNodeIds: string[];
  /** Per-node summary for logging. */
  decisions: Array<{ nodeId: string; nodeName?: string; from: string; to: string; kept?: boolean }>;
}

/**
 * Walk a conversation flow and rewrite the instruction.text of every
 * "Transition" node whose text exactly matches the OLD generator default.
 * Operator-customized text is preserved (logged with kept:true). Already-
 * new text is silent.
 *
 * A "Transition" node here is any conversation-type node that carries a
 * skip_response_edge — that's the structural marker buildTransitionNode()
 * emits and what the Retell dashboard renders as the path-specific
 * acknowledgment beat.
 *
 * MUTATES the passed-in flow.nodes entries in place when rewriting; the
 * caller should pass a deep clone if it cares about the original.
 */
export function computeTransitionNodeUpdates(
  flow: { nodes?: Array<Record<string, unknown>> } | undefined,
): TransitionNodeUpdate {
  const rewrittenNodeIds: string[] = [];
  const decisions: TransitionNodeUpdate["decisions"] = [];
  const nodes = flow?.nodes ?? [];

  for (const node of nodes) {
    if (node.type !== "conversation") continue;
    if (!node.skip_response_edge) continue;

    const instr = node.instruction as { type?: string; text?: string } | undefined;
    const text = instr?.text;
    const nodeId = node.id as string;
    const nodeName = node.name as string | undefined;

    if (text === NEW_TRANSITION_INSTRUCTION) {
      // Already migrated — silent.
      continue;
    }
    if (text === OLD_TRANSITION_INSTRUCTION) {
      (node.instruction as { text: string }).text = NEW_TRANSITION_INSTRUCTION;
      rewrittenNodeIds.push(nodeId);
      decisions.push({ nodeId, nodeName, from: OLD_TRANSITION_INSTRUCTION, to: NEW_TRANSITION_INSTRUCTION });
    } else {
      decisions.push({
        nodeId,
        nodeName,
        from: text ?? "",
        to: NEW_TRANSITION_INSTRUCTION,
        kept: true,
      });
    }
  }

  return { rewrittenNodeIds, decisions };
}

// ── Migration loop ─────────────────────────────────────────────────────────

interface ClientDoc {
  _id: string;
  name?: string;
  retell_agents?: Record<string, Record<string, unknown>>;
}

interface MigrationResult {
  slug: string;
  agentId: string;
  status: "migrated" | "skipped-already" | "skipped-customized" | "error";
  componentsUpdated?: string[];
  detail?: string;
}

async function main(): Promise<void> {
  if (!APPLY) {
    console.log("=== DRY RUN === (pass --apply to write changes)");
  } else {
    console.log("=== APPLY MODE === (writing to Retell + Mongo)");
  }
  if (SLUG_FLAG) console.log(`Slug filter: ${SLUG_FLAG}`);
  if (LIMIT) console.log(`Limit: ${LIMIT}`);
  if (COMPONENT_FILTER !== "all") console.log(`Component filter: ${COMPONENT_FILTER}`);

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

      // Shallow-clone the canonical so a dry-run mutation doesn't poison
      // memory across iterations.
      const draft = JSON.parse(JSON.stringify(canonical)) as Record<string, unknown>;
      const agentName = (draft.agent_name as string) ?? client.name ?? client._id;

      const rootUpdates = COMPONENT_FILTER === "all" || COMPONENT_FILTER === "voice"
        ? computeAgentRootUpdates(draft)
        : { patch: {}, decisions: [] };
      const handbookUpdates = COMPONENT_FILTER === "all" || COMPONENT_FILTER === "handbook"
        ? computeHandbookUpdates(draft)
        : { patch: {}, decisions: [] };
      const promptUpdate = COMPONENT_FILTER === "all" || COMPONENT_FILTER === "prompt"
        ? computeGlobalPromptUpdate(
            ((draft.conversationFlow as Record<string, unknown> | undefined)
              ?.global_prompt as string | undefined) ?? undefined,
          )
        : { newPrompt: null, notes: [] };
      const transitionUpdates = COMPONENT_FILTER === "all" || COMPONENT_FILTER === "transition"
        ? computeTransitionNodeUpdates(
            draft.conversationFlow as { nodes?: Array<Record<string, unknown>> } | undefined,
          )
        : { rewrittenNodeIds: [], decisions: [] };

      const updatedComponents: string[] = [];
      if (Object.keys(rootUpdates.patch).length > 0) updatedComponents.push("voice");
      if (Object.keys(handbookUpdates.patch).length > 0) updatedComponents.push("handbook");
      if (promptUpdate.newPrompt !== null) updatedComponents.push("prompt");
      if (transitionUpdates.rewrittenNodeIds.length > 0) updatedComponents.push("transition");

      if (updatedComponents.length === 0) {
        results.push({ slug: client._id, agentId, status: "skipped-already" });
        console.log(`  [skipped-already] ${client._id} / ${agentName}`);
        continue;
      }

      agentsTouched++;
      console.log(`  [migrate] ${client._id} / ${agentName} (${agentId})`);
      for (const d of rootUpdates.decisions) {
        if (d.kept) continue;
        console.log(`    voice/STT  ${d.field}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`);
      }
      for (const d of handbookUpdates.decisions) {
        if (d.kept) continue;
        console.log(`    handbook   ${d.flag}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`);
      }
      for (const n of promptUpdate.notes) {
        if (n.includes("already")) continue;
        console.log(`    prompt     ${n}`);
      }
      for (const d of transitionUpdates.decisions) {
        if (d.kept) {
          console.log(`    transition ${d.nodeName ?? d.nodeId}: customized (kept)`);
        } else {
          console.log(`    transition ${d.nodeName ?? d.nodeId}: rewritten`);
        }
      }

      if (!APPLY) {
        results.push({
          slug: client._id,
          agentId,
          status: "migrated",
          componentsUpdated: updatedComponents,
          detail: "dry-run",
        });
        continue;
      }

      try {
        // 1. Agent-root push (voice/STT + handbook in a single update call).
        const rootPatch = {
          ...rootUpdates.patch,
          ...handbookUpdates.patch,
        };
        if (Object.keys(rootPatch).length > 0) {
          await retell.agent.update(agentId, rootPatch as never);
        }

        // 2. Conversation-flow push — covers global_prompt + transition-node
        //    rewrites in one call. computeTransitionNodeUpdates already
        //    mutated flow.nodes in place on draft.
        if (promptUpdate.newPrompt !== null || transitionUpdates.rewrittenNodeIds.length > 0) {
          const flow = draft.conversationFlow as Record<string, unknown>;
          const flowId = flow?.conversation_flow_id as string | undefined;
          if (!flowId) {
            throw new Error("missing conversation_flow_id — cannot push flow update");
          }
          if (promptUpdate.newPrompt !== null) {
            flow.global_prompt = promptUpdate.newPrompt;
          }
          await pushFlowToRetell(retell, flowId, draft);
        }

        // 3. Mongo snapshot — update the in-memory canonical so the next
        //    auto-sync run doesn't flag drift on what we just pushed.
        const mongoDraft = { ...draft, ...rootPatch };
        await db.collection<ClientDoc>("clients").updateOne(
          { _id: client._id } as never,
          {
            $set: {
              [`retell_agents.${agentId}`]: mongoDraft,
              last_deployed_at: new Date().toISOString(),
            },
            $inc: { _version: 1 } as never,
          },
        );

        results.push({
          slug: client._id,
          agentId,
          status: "migrated",
          componentsUpdated: updatedComponents,
        });
        console.log(`    ✓ pushed (${updatedComponents.join(", ")})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ slug: client._id, agentId, status: "error", detail: msg });
        console.error(`    ✗ ERROR: ${msg}`);
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const tally: Record<string, number> = {};
  for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
  console.log("\n=== Summary ===");
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
  if (!APPLY) {
    console.log("\nRe-run with --apply to write these changes.");
  } else {
    console.log("\nDone.");
  }
}

const __thisFile = fileURLToPath(import.meta.url);
const __entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (__thisFile === __entryFile) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
