import {
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  defaultExtractEquation,
  isSendSmsAction,
  type DataPoint,
  type RawDataPoint,
  type BranchNode,
  type BranchCondition,
  type FinetuneExample,
  type SendSmsAction,
} from "./data-point-registry.js";
import {
  makeIdFactory,
  generateIds,
  layoutPositions,
  buildEndNode,
  buildIntroNode,
  buildTransitionNode,
  buildFaqNode,
  buildPathRouterNode,
  buildHumanRequestNode,
  buildDataChain,
  buildCloseNode,
  buildMarkCloseSaidNode,
  buildCloseQuestionNode,
  buildClosingSequence,
  buildIrrelevantGuardrailNode,
  buildPoliteHangupNode,
  buildGuardrailEndNode,
  buildAgentRoot,
  buildTransferCallNode,
  buildLiveTransferRecoveryNode,
  buildPreTransferNode,
  buildPerPathTransferCallNode,
  buildMcpServerEntry,
  type AgentConfig,
  type HumanRequestMode,
  type IntroPathConfig,
} from "./node-builders.js";
import { config } from "../../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PathEndMode = "callback" | "transfer";

export interface PathConfig {
  name: string;
  transitionCondition: string;
  dataPoints: RawDataPoint[];
  endMode?: PathEndMode;
  /** Resolved E.164 number to transfer to. Required when endMode === "transfer". */
  transferDestination?: string;
  /** Positive examples that should route the caller to this path. Merged
   *  into the intro node's finetune_transition_examples at generation time
   *  with destination_node_id set to this path's transition node. */
  transitionFinetuneExamples?: FinetuneExample[];
}

/** The flattened, in-order sequence a path compiles into: data points and
 *  inline SMS actions. Data points feed the standard Collect+Confirm pair
 *  pattern; SMS actions become Retell function nodes wired into the same
 *  Variables Router that orchestrates the path's data collection. */
export type ResolvedSequenceItem = DataPoint | SendSmsAction;

export interface ResolvedPath {
  name: string;
  resolved: ResolvedSequenceItem[];
  endMode: PathEndMode;
  transferDestination?: string;
}

// ── Resolve Data Points ──────────────────────────────────────────────────────

function isBranchNode(dp: RawDataPoint): dp is BranchNode {
  return typeof dp === "object" && "_branch" in dp && dp._branch === true;
}

function resolveSingleDataPoint(
  dp: RawDataPoint,
  index: number,
  registry: Record<string, DataPoint>,
): DataPoint {
  if (typeof dp === "string") {
    const entry = registry[dp];
    if (!entry) {
      throw new Error(
        `Unknown data point "${dp}". Available: ${Object.keys(registry).join(", ")}`,
      );
    }
    return { ...entry };
  }
  if ((dp as any).composite) {
    return dp as DataPoint;
  }
  const obj = dp as Partial<DataPoint> & { variableName?: string };
  if (!obj.variableName)
    throw new Error(`dataPoints[${index}] missing required field: variableName`);
  // Workspace-default fallback: when a per-agent override doesn't set a field,
  // pull from the registry (workspace default) before falling through to the
  // algorithmic boilerplate. `??` (not `||`) so an explicit "" / [] from the
  // operator is preserved.
  const defaults = registry[obj.variableName];
  const resolved: DataPoint = {
    label:
      obj.label ||
      obj.variableName
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c: string) => c.toUpperCase()),
    variableName: obj.variableName,
    type: obj.type || "string",
    choices: obj.choices || [],
    description:
      obj.description ||
      `${obj.variableName}. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt:
      obj.conversationPrompt ??
      defaults?.conversationPrompt ??
      (obj.orphan ? "" :
      `Ask the caller for their ${obj.variableName.replace(/_/g, " ")}.\n\nDo not give examples unless they are unsure, then you can provide them up to three examples.\n\nIf the caller says they don't know, acknowledge it and move on.`),
    forwardCondition:
      obj.forwardCondition ??
      defaults?.forwardCondition ??
      (obj.orphan ? "" :
      `The caller has provided their ${obj.variableName.replace(/_/g, " ")} or has indicated they don't know it`),
    finetuneExamples:
      obj.finetuneExamples ??
      defaults?.finetuneExamples ??
      [],
    extractSuccessEquation: obj.extractSuccessEquation ||
      defaultExtractEquation(obj.variableName),
  };
  if (obj.orphan) resolved.orphan = true;
  return resolved;
}

// Overload: callers that pass only DPs (no SMS actions in the input type) get
// the historical DataPoint[] return type back, so existing tests and callers
// continue to typecheck without casts. The broader RawDataPoint[] overload
// returns the union and is what generate-agent.ts itself consumes.
export function resolveDataPoints(
  rawDataPoints: Array<string | BranchNode | (Partial<DataPoint> & { variableName?: string })>,
  defaults: Record<string, DataPoint>,
): DataPoint[];
export function resolveDataPoints(
  rawDataPoints: RawDataPoint[],
  defaults: Record<string, DataPoint>,
): ResolvedSequenceItem[];
export function resolveDataPoints(
  rawDataPoints: RawDataPoint[],
  defaults: Record<string, DataPoint>,
): ResolvedSequenceItem[] {
  if (!defaults || Object.keys(defaults).length === 0) {
    throw new Error(
      "No data point defaults provided. Ensure MongoDB data_point_defaults collection is populated.",
    );
  }

  const registry = defaults;

  function flatten(
    items: RawDataPoint[],
    parentConditions: BranchCondition[],
  ): ResolvedSequenceItem[] {
    const result: ResolvedSequenceItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const dp = items[i];

      if (isBranchNode(dp)) {
        const ifCondition: BranchCondition = {
          variable: dp.variable,
          operator: dp.operator,
          value: dp.value,
        };
        const elseOperator = dp.operator === "==" ? "!=" : "==" as const;
        const elseCondition: BranchCondition = {
          variable: dp.variable,
          operator: elseOperator,
          value: dp.value,
        };

        // Recursively resolve IF chain with accumulated conditions
        const ifItems = flatten(
          dp.ifChain || (dp as any).ifDataPoints || [],
          [...parentConditions, ifCondition],
        );
        // v1 restriction: SMS actions inside branch chains aren't supported.
        // The router gate needs unconditional placement to wire cleanly;
        // conditional actions would require ANDing branch equations onto the
        // sentinel check, which is doable but deferred.
        for (const it of ifItems) {
          if (isSendSmsAction(it)) {
            throw new Error(
              `SMS actions inside branch chains aren't supported yet. Move the action to the top level of the path's dataPoints[].`,
            );
          }
        }
        result.push(...ifItems);

        // Recursively resolve ELSE chain with inverted condition
        const elseItems = flatten(
          dp.elseChain || (dp as any).elseDataPoints || [],
          [...parentConditions, elseCondition],
        );
        for (const it of elseItems) {
          if (isSendSmsAction(it)) {
            throw new Error(
              `SMS actions inside branch chains aren't supported yet. Move the action to the top level of the path's dataPoints[].`,
            );
          }
        }
        result.push(...elseItems);
      } else if (isSendSmsAction(dp)) {
        // Pass through unchanged. The data-chain builder consumes this
        // alongside DataPoints to emit a Retell function node.
        result.push(dp);
      } else {
        const resolved = resolveSingleDataPoint(dp, i, registry);
        if (parentConditions.length > 0) {
          resolved._branchConditions = [...parentConditions];
        }
        result.push(resolved);
      }
    }

    return result;
  }

  return flatten(rawDataPoints, []);
}

// ── Main Generator ───────────────────────────────────────────────────────────

export function generateAgent(
  agentConfig: AgentConfig,
  rawDataPoints: RawDataPoint[],
  pathConfigs: PathConfig[] | undefined,
  defaults: Record<string, DataPoint>,
): {
  agent: Record<string, unknown>;
  resolved: DataPoint[];
  resolvedPaths?: ResolvedPath[];
} {
  const { businessName, faqKnowledgeBase } = agentConfig;
  const f = makeIdFactory();

  // Normalize: if pathConfigs provided, use them; otherwise wrap rawDataPoints as single path
  const hasPaths = pathConfigs && pathConfigs.length > 0;
  const paths = hasPaths
    ? pathConfigs
    : [
        {
          name: "Default",
          transitionCondition:
            "The caller confirms forward intent with service, including wanting to sign up, get a quote, schedule service, or get started.",
          dataPoints: rawDataPoints,
        },
      ];

  const isMultiPath = paths.length > 1;

  // Validate and resolve data points per path
  const resolvedPaths: ResolvedPath[] = paths.map((p) => {
    // Empty data-point arrays are allowed — useful for "if intent matches,
    // transfer/callback immediately" paths where no data collection happens.
    const dataPoints = p.dataPoints || [];
    const endMode: PathEndMode = p.endMode === "transfer" ? "transfer" : "callback";
    if (endMode === "transfer" && !p.transferDestination) {
      throw new Error(
        `Path "${p.name}" end mode is "transfer" but no dispatch call number is set (per-path or client default)`,
      );
    }
    try {
      return {
        name: p.name,
        resolved: dataPoints.length === 0 ? [] : resolveDataPoints(dataPoints, defaults),
        endMode,
        transferDestination: p.transferDestination,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Path "${p.name}": ${msg}`);
    }
  });

  // All resolved data points (flattened, for backward compat). SMS actions
  // are filtered out here — callers consuming this list (e.g. notification
  // builders, agent_versions snapshots) only care about variable shapes.
  const allResolved: DataPoint[] = resolvedPaths
    .flatMap((p) => p.resolved)
    .filter((it): it is DataPoint => !isSendSmsAction(it));

  // Generate IDs and positions for all paths
  const pathSequences = resolvedPaths.map((p) => p.resolved);
  const pathEndModes = resolvedPaths.map((p) => p.endMode);
  const anyTransferPath = pathEndModes.some((m) => m === "transfer");
  const anySmsActions = pathSequences.some((seq) => seq.some(isSendSmsAction));
  const ids = generateIds(f, pathSequences, pathEndModes);
  const pos = layoutPositions(pathSequences, pathEndModes);

  const globalPrompt = `You are Anthony, an inbound receptionist for ${businessName}.

Always refer to the business by that name when relevant.

Your primary goal is to:
1. Clearly understand what the caller is calling about.
2. Help them with their request.

Never:
- Pressure, persuade, or argue
- Invent information you don't have

Only reveal to the caller that you are an AI if they explicitly ask.

Ask one question at a time. Keep questions as short as possible.

Unless otherwise asked of you, do not repeat back what the caller said back to them.

When appropriate to acknowledge, only use short acknowledgments such as:
- Got it
- Understood
- Noted
- Gotcha

## Listing Rule
When listing anything — services, time slots, examples, options — never list more than 3 items at a time, unless explicitly asked by the caller.
`;

  // Build all nodes
  const allNodes: Record<string, unknown>[] = [];

  // Shared structural nodes
  allNodes.push(buildEndNode(ids, pos));
  allNodes.push(
    buildIntroNode(
      agentConfig,
      ids,
      pos,
      f,
      isMultiPath
        ? paths.map((p) => ({
            name: p.name,
            transitionCondition: p.transitionCondition,
            transitionFinetuneExamples: p.transitionFinetuneExamples,
          }))
        : undefined,
    ),
  );

  // Per-path nodes: transition + data chain (+ optional pre-transfer + transfer-call)
  resolvedPaths.forEach((rp, pathIdx) => {
    const pIds = ids.paths[pathIdx];
    const pPos = pos.paths[pathIdx];
    const pathLabel = isMultiPath ? rp.name : undefined;

    // Variables Router's else_edge points here when all data is collected.
    // - "callback" multi-path: this path's own Close node (per-path prompt)
    // - "callback" single-path: the shared Close node (legacy layout)
    // - "transfer": this path's Pre-Transfer node
    const terminalId =
      rp.endMode === "transfer" && pIds.preTransferId
        ? pIds.preTransferId
        : pIds.closeId
          ? pIds.closeId
          : ids.closeId;

    if (rp.resolved.length === 0) {
      // Empty data chain: transition skips the entire collection scaffold and
      // jumps straight to the terminal (Close for callback, Pre-Transfer for
      // transfer). No Extract / Router / collect / confirm nodes generated.
      allNodes.push(buildTransitionNode(pIds, pPos, f, pathLabel, terminalId));
    } else {
      allNodes.push(buildTransitionNode(pIds, pPos, f, pathLabel));
      allNodes.push(
        ...buildDataChain(rp.resolved, pIds, pPos, terminalId, ids.closeQuestionId, f, pathLabel),
      );
    }

    if (rp.endMode === "transfer") {
      if (!rp.transferDestination) {
        throw new Error(`Path "${rp.name}": missing transferDestination`);
      }
      allNodes.push(buildPreTransferNode(pIds, pPos, agentConfig, pathLabel, f));
      allNodes.push(
        buildPerPathTransferCallNode(
          pIds,
          pPos,
          ids,
          rp.transferDestination,
          pathLabel,
          f,
          agentConfig.warmTransferAgentVersion,
        ),
      );
    }
  });

  // Shared global + closing nodes
  const humanMode: HumanRequestMode = agentConfig.humanRequestMode || "callback";
  allNodes.push(
    buildFaqNode(
      faqKnowledgeBase,
      ids,
      pos,
      f,
      isMultiPath,
      agentConfig.faqGlobalFinetuneExamples,
      agentConfig.faqConversationFinetuneExamples,
    ),
  );
  // Path Router sits on FAQ's outgoing "answered" edge. Routes back to
  // the matching path's Variables Router when `_path_taken` is set,
  // else falls through to Intro. Makes mid-call FAQ returns
  // deterministic when Retell's `go_back_conditions` doesn't fire.
  allNodes.push(buildPathRouterNode(ids, pos, f, paths as IntroPathConfig[]));
  allNodes.push(
    buildHumanRequestNode(ids, pos, f, humanMode, agentConfig.humanRequestFinetuneExamples),
  );
  if (humanMode === "live_transfer") {
    allNodes.push(buildTransferCallNode(ids, pos, f, agentConfig.warmTransferAgentVersion));
  }
  // Build the shared Live Transfer Recovery node when any transfer path exists.
  if (humanMode === "live_transfer" || anyTransferPath) {
    allNodes.push(buildLiveTransferRecoveryNode(agentConfig, ids, pos, f));
  }
  // Close nodes:
  // - Multi-path: one per callback path, with per-path prompt support.
  //   Each path's Variables Router else_edge points to its own Close node;
  //   each Close always_edges to the shared Closing Remarks.
  // - Single-path: one shared Close node (legacy layout). Same in both cases:
  //   Closing Remarks → Closing Statement remain singular.
  if (isMultiPath) {
    resolvedPaths.forEach((rp, pathIdx) => {
      const pIds = ids.paths[pathIdx];
      if (rp.endMode === "transfer" || !pIds.closeId) return;
      // Each callback path stacks its own Close vertically below the
      // last path. layoutPositions stamps a `close` Position on the
      // PathPositions for non-transfer paths; fall back to the shared
      // pos.close if it's missing for any reason.
      const perPathClose = pos.paths[pathIdx].close;
      const markCloseSaidId = pIds.markCloseSaidId;
      if (!markCloseSaidId) {
        throw new Error(
          `Path "${rp.name}": expected markCloseSaidId for non-transfer path`,
        );
      }
      allNodes.push(
        buildCloseNode(agentConfig, ids, pos, f, markCloseSaidId, {
          nodeId: pIds.closeId,
          pathName: rp.name,
          displayPosition: perPathClose,
        }),
      );
      const markCloseSaidPos = pos.paths[pathIdx].markCloseSaid;
      if (!markCloseSaidPos) {
        throw new Error(
          `Path "${rp.name}": expected markCloseSaid display position`,
        );
      }
      allNodes.push(
        buildMarkCloseSaidNode(ids, f, markCloseSaidId, markCloseSaidPos, rp.name),
      );
    });
  } else {
    // Single-path. Transfer paths skip Close entirely (router's
    // else_edge → Pre-Transfer instead). Callback single-path emits
    // Close + Mark Close Said via paths[0]'s allocated ids.
    if (resolvedPaths[0]?.endMode !== "transfer") {
      const singlePathMarkCloseSaidId = ids.paths[0]?.markCloseSaidId;
      if (!singlePathMarkCloseSaidId) {
        throw new Error("Single-path callback agent: expected markCloseSaidId on paths[0]");
      }
      allNodes.push(
        buildCloseNode(agentConfig, ids, pos, f, singlePathMarkCloseSaidId),
      );
      const markCloseSaidPos = pos.paths[0]?.markCloseSaid;
      if (!markCloseSaidPos) {
        throw new Error("Single-path callback agent: expected markCloseSaid display position");
      }
      allNodes.push(
        buildMarkCloseSaidNode(ids, f, singlePathMarkCloseSaidId, markCloseSaidPos),
      );
    }
  }
  // Close Question sits between the (single or per-path) Close node(s) and
  // the shared Closing Remarks. All Close nodes always_edge to this single
  // node so the "anything else?" wording stays consistent across paths.
  allNodes.push(buildCloseQuestionNode(agentConfig, ids, pos, f));
  allNodes.push(...buildClosingSequence(agentConfig, ids, pos, f));
  allNodes.push(buildIrrelevantGuardrailNode(ids, pos, f, agentConfig.irrelevantGuardrailFinetuneExamples));
  allNodes.push(buildPoliteHangupNode(ids, pos, f));
  allNodes.push(buildGuardrailEndNode(ids, pos));

  // Register the servicecall-mcp server only when a path actually fires SMS.
  // McpNodes reference this entry by its `name`; without it, Retell rejects
  // the flow ("nodes/N must have required property 'mcp_id'").
  const flowMcps = anySmsActions ? [buildMcpServerEntry(config.API_KEY)] : [];

  const conversationFlow = {
    version: 1,
    global_prompt: globalPrompt,
    start_node_id: ids.introId,
    start_speaker: "agent",
    tools: [],
    mcps: flowMcps,
    model_choice: {
      type: "cascading",
      model: "gpt-4.1",
      high_priority: true,
    },
    tool_call_strict_mode: true,
    default_dynamic_variables: {},
    knowledge_base_ids: [],
    kb_config: { top_k: 3, filter_score: 0.6 },
    begin_tag_display_position: { x: pos.intro.x - 168, y: pos.intro.y - 426 },
    is_published: false,
    flex_mode: false,
    is_transfer_cf: false,
    nodes: allNodes,
    components: [],
  };

  const agent = buildAgentRoot(businessName, conversationFlow);

  return {
    agent,
    resolved: allResolved,
    resolvedPaths: isMultiPath ? resolvedPaths : undefined,
  };
}
