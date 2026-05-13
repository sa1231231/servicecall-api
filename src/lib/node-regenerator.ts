/**
 * Regenerates the data chain portion of a conversation flow for a specific path.
 * Uses the same patterns as node-builders.ts buildDataChain() but operates on
 * an existing parsed flow, preserving node IDs and custom prompts where possible.
 */

import type { DataPoint, SendSmsAction } from "./agent-generator/data-point-registry.js";
import { NOT_MENTIONED, PHONE_COLLECTED_FLAG, PATH_TAKEN_VAR, isSendSmsAction } from "./agent-generator/data-point-registry.js";
import { makeIdFactory, MCP_SERVER_NAME, SEND_SMS_TOOL_NAME, resolveFinetuneExamples, type IdFactory, type PathIds } from "./agent-generator/node-builders.js";
import type { ParsedPath, ParsedDataPoint } from "./node-parser.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface RegenerateResult {
  /** Replacement nodes for the path (front-extract + router + data chain) */
  newNodes: Record<string, unknown>[];
  /** Node IDs that should be removed from the full nodes array */
  removedNodeIds: Set<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toVarDefs(dp: DataPoint) {
  if (dp.composite && dp.variables) {
    return dp.variables.map((v) => {
      const def: Record<string, unknown> = {
        name: v.variableName,
        type: v.type,
        description: v.description,
      };
      if (v.type === "enum") def.choices = v.choices;
      return def;
    });
  }
  const def: Record<string, unknown> = {
    name: dp.variableName,
    type: dp.type,
    description: dp.description,
  };
  if (dp.type === "enum") def.choices = dp.choices;
  return [def];
}

function randomSuffix(len: number): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len)
    .padEnd(len, "0");
}

/** Extract the highest numeric counter from node/edge IDs in a path to avoid collisions */
function maxNodeCounter(path: ParsedPath): number {
  let max = Date.now();
  const allNodes = [
    path.transitionNode,
    path.frontExtractNode,
    path.routerNode,
    ...path.dataChain.flatMap((dp) => [dp.collectNode, dp.confirmNode]),
    ...path.smsActions.flatMap((a) => [a.funcNode, a.markSentNode]),
  ];
  for (const node of allNodes) {
    const m = node.id.match(/node-(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

// ── Main Regenerator ─────────────────────────────────────────────────────────

/**
 * Regenerates the data chain for a given path with an updated set of data points.
 *
 * Preserves:
 * - Existing node IDs for unchanged data points (same variableName, same position)
 * - Custom prompt text on existing collect nodes (Retell console tweaks)
 * - The front-extract node ID and router node ID
 * - display_position values from existing nodes
 *
 * Generates new IDs only for genuinely new nodes.
 */
export function regenerateDataChain(
  existingPath: ParsedPath,
  newSequence: Array<DataPoint | SendSmsAction>,
  closeNodeId: string,
  pathName?: string,
): RegenerateResult {
  // Partition the union sequence into DP-only and SMS-only views — internal
  // bookkeeping mirrors the buildDataChain pattern in node-builders.ts.
  const newDataPoints = newSequence.filter((it): it is DataPoint => !isSendSmsAction(it));
  const newSmsItems = newSequence.filter((it): it is SendSmsAction => isSendSmsAction(it));

  // For transfer-mode paths, the Variables Router's else_edge points to the
  // path's Pre-Transfer node (which always-edges into Transfer Call).
  // For callback-mode paths, it points to the shared Close node.
  const terminalNodeId =
    existingPath.endMode === "transfer" && existingPath.preTransferNode
      ? existingPath.preTransferNode.id
      : closeNodeId;
  // Derive a safe ID base above any existing node counter to avoid collisions
  const f = makeIdFactory(maxNodeCounter(existingPath) + 1000);
  const suffix = pathName ? ` (${pathName})` : "";

  // Map existing data points by variableName for reuse
  const existingByVar = new Map<string, ParsedDataPoint>();
  for (const dp of existingPath.dataChain) {
    existingByVar.set(dp.variableName, dp);
  }

  // Collect all old node IDs (to be removed from the full array)
  const removedNodeIds = new Set<string>();
  removedNodeIds.add(existingPath.frontExtractNode.id);
  removedNodeIds.add(existingPath.routerNode.id);
  for (const dp of existingPath.dataChain) {
    removedNodeIds.add(dp.collectNode.id);
    removedNodeIds.add(dp.confirmNode.id);
  }
  for (const action of existingPath.smsActions) {
    removedNodeIds.add(action.funcNode.id);
    removedNodeIds.add(action.markSentNode.id);
  }

  // Pre-allocate IDs: reuse existing where possible, generate new otherwise.
  //
  // Orphan dps (extract-only) don't actually get Collect/Confirm nodes
  // built — the loop below returns early on `dp.orphan`. But chainIds is
  // 1:1 with newDataPoints, so we still allocate a slot. We must NOT reuse
  // existing.collectNode.id here when the existing dp was parsed as orphan,
  // because in that case collectNode === frontExtractNode (placeholder per
  // node-parser.ts:327). Reusing it would put the placeholder id into a
  // chain slot, and if downstream code ever pushed a Collect node with
  // that id it would collide with the front-extract node — emitting the
  // "Duplicate node id" validation error we hit. Allocating a fresh id
  // for orphan slots keeps the ids disjoint regardless.
  const chainIds: Array<{ convId: string; confirmId: string }> = newDataPoints.map((dp) => {
    const existing = existingByVar.get(dp.variableName);
    if (existing && !existing.orphan && !dp.orphan) {
      return {
        convId: existing.collectNode.id,
        confirmId: existing.confirmNode.id,
      };
    }
    return {
      convId: f.nodeId(),
      confirmId: f.nodeId(),
    };
  });

  // SMS-action IDs: match new items to existing by source-order index. The Nth
  // new SMS reuses the Nth existing SMS's funcId/markSentId/sentinelVar so
  // Retell-side annotations on those nodes survive a save. For SMS items that
  // exceed the existing count, allocate fresh IDs and a fresh sentinel name
  // starting above the existing max.
  let smsSentinelCounter = 0;
  for (const action of existingPath.smsActions) {
    const m = action.sentinelVar.match(/^is_sms_sent_(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > smsSentinelCounter) smsSentinelCounter = n;
    }
  }
  const smsIds: Array<{ funcId: string; markSentId: string; sentinelVar: string }> = newSmsItems.map(
    (_, i) => {
      const existing = existingPath.smsActions[i];
      if (existing) {
        return {
          funcId: existing.funcNode.id,
          markSentId: existing.markSentNode.id,
          sentinelVar: existing.sentinelVar,
        };
      }
      return {
        funcId: f.nodeId(),
        markSentId: f.nodeId(),
        sentinelVar: `is_sms_sent_${++smsSentinelCounter}`,
      };
    },
  );

  const frontExtractId = existingPath.frontExtractNode.id;
  const routerId = existingPath.routerNode.id;

  // Layout: use existing positions as base, extend as needed
  const BASE_X = -954;
  const STEP_X = 550;
  const existingFrontExtractPos = (existingPath.frontExtractNode.raw.display_position as { x: number; y: number }) ?? { x: -18, y: 0 };
  const existingRouterPos = (existingPath.routerNode.raw.display_position as { x: number; y: number }) ?? { x: -18, y: 450 };
  const yBase = existingFrontExtractPos.y;

  const nodes: Record<string, unknown>[] = [];

  // ── Front-loaded Extract: all variables ───────────────────────────────

  const allVariableDefs = newDataPoints.flatMap(toVarDefs);
  if (pathName) {
    allVariableDefs.push({
      name: PATH_TAKEN_VAR,
      type: "string",
      description: `Always set to "${pathName}".`,
    });
  }

  nodes.push({
    variables: allVariableDefs,
    else_edge: {
      destination_node_id: routerId,
      id: `${frontExtractId}-else-edge`,
      transition_condition: { type: "prompt", prompt: "Else" },
    },
    name: `Extract All Variables${suffix}`,
    edges: [],
    finetune_transition_examples: [],
    id: frontExtractId,
    type: "extract_dynamic_variables",
    display_position: existingFrontExtractPos,
  });

  // ── Variables Router ──────────────────────────────────────────────────
  // Walk the source-order sequence and emit one router edge per item (DP
  // gated on "var missing", SMS gated on "sentinel not yet flipped"). Source
  // order = router-edge order; Retell's branch is first-match-wins, so an
  // SMS edge between DP1 and DP2 only fires after DP1 is collected. Orphan
  // DPs are extract-only — skip them in the router.
  const routerEdges: Record<string, unknown>[] = [];
  let dpIdx = 0;
  let smsIdx = 0;
  for (const item of newSequence) {
    if (isSendSmsAction(item)) {
      const sIds = smsIds[smsIdx++];
      routerEdges.push({
        destination_node_id: sIds.funcId,
        id: f.edgeId(),
        transition_condition: {
          type: "equation",
          equations: [
            { left: `{{${sIds.sentinelVar}}}`, operator: "not_exist" },
            { left: `{{${sIds.sentinelVar}}}`, operator: "!=", right: "true" },
          ],
          operator: "||",
        },
      });
      continue;
    }

    const dp = item;
    const i = dpIdx++;
    if (dp.orphan) continue;
    let missingEquations: any[];
    let missingOperator: string;

    if (dp.variableName === "phone_number") {
      missingEquations = [
        { left: `{{phone_number}}`, operator: "==", right: NOT_MENTIONED },
        { left: `{{${PHONE_COLLECTED_FLAG}}}`, operator: "!=", right: "true" },
      ];
      missingOperator = "&&";
    } else if (dp.composite && dp.variables) {
      missingEquations = dp.variables.flatMap((v) => [
        { left: `{{${v.variableName}}}`, operator: "not_exist" },
        { left: `{{${v.variableName}}}`, operator: "==", right: NOT_MENTIONED },
      ]);
      missingOperator = "||";
    } else {
      missingEquations = [
        { left: `{{${dp.variableName}}}`, operator: "not_exist" },
        { left: `{{${dp.variableName}}}`, operator: "==", right: NOT_MENTIONED },
      ];
      missingOperator = "||";
    }

    // Preserve branch conditions
    if (dp._branchConditions && dp._branchConditions.length > 0) {
      const branchEqs: any[] = [];
      for (const bc of dp._branchConditions) {
        branchEqs.push({
          left: `{{${bc.variable}}}`,
          operator: bc.operator,
          right: bc.value,
        });
        if (bc.operator === "!=") {
          branchEqs.push(
            { left: `{{${bc.variable}}}`, operator: "!=", right: NOT_MENTIONED },
            { left: `{{${bc.variable}}}`, operator: "!=", right: "Caller Doesn't Know" },
          );
        }
      }
      routerEdges.push({
        destination_node_id: chainIds[i].convId,
        id: f.edgeId(),
        transition_condition: {
          type: "equation",
          equations: [...missingEquations, ...branchEqs],
          operator: "&&",
        },
      });
      continue;
    }

    routerEdges.push({
      destination_node_id: chainIds[i].convId,
      id: f.edgeId(),
      transition_condition: {
        type: "equation",
        equations: missingEquations,
        operator: missingOperator,
      },
    });
  }

  nodes.push({
    name: `Variables Router${suffix}`,
    edges: routerEdges,
    id: routerId,
    else_edge: {
      destination_node_id: terminalNodeId,
      id: `${routerId}-else-edge`,
      transition_condition: { type: "prompt", prompt: "Else" },
    },
    type: "branch",
    display_position: existingRouterPos,
  });

  // ── Per-variable: Collect + Confirm ───────────────────────────────────

  newDataPoints.forEach((dp, i) => {
    if (dp.orphan) return; // Extract-only: no Collect+Confirm nodes
    const ids = chainIds[i];
    const existing = existingByVar.get(dp.variableName);

    // Variable list for this Confirm extract:
    //   • Non-orphan dps taper down the chain (already-collected vars drop off)
    //   • Orphan dps persist in every NON-composite Confirm extract. Composites
    //     skip orphan persistence so the parser can keep treating their
    //     Confirm.variables as the canonical sub-var list (see the comment
    //     in node-builders.ts buildDataChain for the full rationale).
    const taperedNonOrphans = newDataPoints.slice(i).filter((d) => !d.orphan);
    const persistentOrphans = dp.composite ? [] : newDataPoints.filter((d) => d.orphan);
    const remainingVarDefs = [...taperedNonOrphans, ...persistentOrphans].flatMap(toVarDefs);

    // Layout position: reuse existing or compute new
    const convPos = existing
      ? (existing.collectNode.raw.display_position as { x: number; y: number })
      : { x: BASE_X + i * STEP_X, y: yBase + 900 };
    const confirmPos = existing
      ? (existing.confirmNode.raw.display_position as { x: number; y: number })
      : { x: BASE_X + i * STEP_X, y: yBase + 1350 };

    // Collect node — prefer existing prompt text (preserves Retell console tweaks)
    const conversationPrompt = existing
      ? existing.conversationPrompt
      : dp.conversationPrompt;
    const forwardCondition = existing
      ? existing.forwardCondition
      : dp.forwardCondition;

    // Fine-tune precedence: resolved DataPoint wins when it has examples
    // (this is what propagates workspace-default edits into the published
    // flow on save-and-publish). Fall back to whatever's on the existing
    // node only when the resolved DP carries nothing — that path preserves
    // an empty default rather than re-importing whatever Retell's console
    // happens to have. Conversation examples have no operator-facing UI;
    // always reuse what's on the node.
    const existingCollectRaw = existing?.collectNode.raw;
    const finetuneConv = (existingCollectRaw?.finetune_conversation_examples as any[]) ?? [];
    const finetuneTrans =
      dp.finetuneExamples && dp.finetuneExamples.length > 0
        ? resolveFinetuneExamples(dp.finetuneExamples, ids.confirmId, {}, f)
        : ((existingCollectRaw?.finetune_transition_examples as any[]) ?? []);

    nodes.push({
      name: dp.composite ? dp.label : `Collect ${dp.label}`,
      edges: [
        {
          destination_node_id: ids.confirmId,
          id: f.edgeId(),
          transition_condition: {
            type: "prompt",
            prompt: forwardCondition,
          },
        },
      ],
      finetune_transition_examples: finetuneTrans,
      finetune_conversation_examples: finetuneConv,
      id: ids.convId,
      type: "conversation",
      display_position: convPos,
      instruction: { type: "prompt", text: conversationPrompt },
    });

    // Phone number collected flag
    if (dp.variableName === "phone_number") {
      remainingVarDefs.push({
        name: PHONE_COLLECTED_FLAG,
        type: "boolean",
        description: "Always set to true",
      });
    }

    // Confirm node — extract remaining variables
    // Preserve any existing finetune examples
    const existingConfirmRaw = existing?.confirmNode.raw;
    const confirmFinetune = (existingConfirmRaw?.finetune_transition_examples as any[]) ?? [];

    nodes.push({
      variables: remainingVarDefs,
      else_edge: {
        destination_node_id: routerId,
        id: `${ids.confirmId}-else-edge`,
        transition_condition: { type: "prompt", prompt: "Else" },
      },
      name: `Confirm ${dp.label}`,
      edges: [],
      finetune_transition_examples: confirmFinetune,
      id: ids.confirmId,
      type: "extract_dynamic_variables",
      display_position: confirmPos,
    });
  });

  // ── SMS-action node pairs ─────────────────────────────────────────────
  // Function node (invokes send_sms) + Mark Sent extract node. Mirrors
  // buildSendSmsNode in node-builders.ts; kept inline here so the regenerator
  // can preserve existing node IDs and positions where they exist.
  const SMS_Y_FUNC = 1800;
  const SMS_Y_MARK = 2250;
  newSmsItems.forEach((action, smsItemIdx) => {
    const sIds = smsIds[smsItemIdx];
    const existing = existingPath.smsActions[smsItemIdx];
    // Source-order column index for this SMS in the union sequence
    const colIdx = newSequence.findIndex((it, k) => {
      if (!isSendSmsAction(it)) return false;
      // Count SMS items up to and including position k
      let count = -1;
      for (let j = 0; j <= k; j++) {
        if (isSendSmsAction(newSequence[j])) count++;
      }
      return count === smsItemIdx;
    });
    const funcPos =
      (existing?.funcNode.raw.display_position as { x: number; y: number }) ??
      { x: -954 + colIdx * 550, y: yBase + SMS_Y_FUNC };
    const markSentPos =
      (existing?.markSentNode.raw.display_position as { x: number; y: number }) ??
      { x: -954 + colIdx * 550, y: yBase + SMS_Y_MARK };

    const displayName = action.name ?? "Send SMS";
    const argsObj: Record<string, unknown> = { message: action.template };
    if (action.to) argsObj.to = action.to;
    const argsJson = JSON.stringify(argsObj);

    nodes.push({
      id: sIds.funcId,
      type: "mcp",
      mcp_id: MCP_SERVER_NAME,
      mcp_tool_name: SEND_SMS_TOOL_NAME,
      wait_for_result: true,
      name: `${displayName}${suffix}`,
      instruction: {
        type: "static_text",
        text: `Call send_sms with: ${argsJson}`,
      },
      display_position: funcPos,
      edges: [
        {
          id: f.edgeId(),
          transition_condition: { type: "prompt", prompt: "Tool call succeeded" },
          destination_node_id: sIds.markSentId,
        },
      ],
      else_edge: {
        id: f.edgeId(),
        transition_condition: { type: "prompt", prompt: "Else" },
        destination_node_id: sIds.markSentId,
      },
    });

    nodes.push({
      variables: [
        {
          name: sIds.sentinelVar,
          type: "boolean",
          description: "Always set to true.",
        },
      ],
      else_edge: {
        destination_node_id: routerId,
        id: `${sIds.markSentId}-else-edge`,
        transition_condition: { type: "prompt", prompt: "Else" },
      },
      name: `Mark ${displayName} Sent${suffix}`,
      edges: [],
      id: sIds.markSentId,
      type: "extract_dynamic_variables",
      display_position: markSentPos,
    });
  });

  return { newNodes: nodes, removedNodeIds };
}

/**
 * Applies a regenerated data chain to a canonical JSON, replacing old nodes
 * with new ones while preserving all other nodes.
 */
export function applyRegeneratedChain(
  canonicalJson: Record<string, unknown>,
  result: RegenerateResult,
): void {
  const flow = canonicalJson.conversationFlow as Record<string, unknown>;
  const nodes = flow.nodes as Array<Record<string, unknown>>;

  // Remove old chain nodes
  const filtered = nodes.filter((n) => !result.removedNodeIds.has(n.id as string));

  // Add new chain nodes
  filtered.push(...result.newNodes);

  flow.nodes = filtered;
}
