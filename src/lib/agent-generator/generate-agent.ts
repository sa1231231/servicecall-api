import {
  DATA_POINT_REGISTRY,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  defaultExtractEquation,
  type DataPoint,
  type RawDataPoint,
  type BranchNode,
  type BranchCondition,
} from "./data-point-registry.js";
import {
  makeIdFactory,
  generateIds,
  layoutPositions,
  buildEndNode,
  buildIntroNode,
  buildTransitionNode,
  buildFaqNode,
  buildHumanRequestNode,
  buildDataChain,
  buildCloseNode,
  buildClosingSequence,
  buildIrrelevantGuardrailNode,
  buildEmergencyGuardrailNode,
  buildPoliteHangupNode,
  buildGuardrailEndNode,
  buildAgentRoot,
  buildTransferCallNode,
  buildTransferFailedNode,
  type AgentConfig,
  type HumanRequestMode,
} from "./node-builders.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PathConfig {
  name: string;
  transitionCondition: string;
  dataPoints: RawDataPoint[];
}

export interface ResolvedPath {
  name: string;
  resolved: DataPoint[];
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
  return {
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
      obj.conversationPrompt ||
      `Ask the caller for their ${obj.variableName.replace(/_/g, " ")}.\n\nDo not give examples unless they are unsure, then you can provide them up to three examples.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition:
      obj.forwardCondition ||
      `The caller has provided their ${obj.variableName.replace(/_/g, " ")} or has indicated they don't know it`,
    finetuneExamples: obj.finetuneExamples || [],
    extractSuccessEquation: obj.extractSuccessEquation ||
      defaultExtractEquation(obj.variableName),
  };
}

export function resolveDataPoints(
  rawDataPoints: RawDataPoint[],
  defaults?: Record<string, DataPoint>,
): DataPoint[] {
  const registry = defaults && Object.keys(defaults).length > 0
    ? defaults
    : DATA_POINT_REGISTRY;

  const result: DataPoint[] = [];

  for (let i = 0; i < rawDataPoints.length; i++) {
    const dp = rawDataPoints[i];

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

      // Resolve IF-branch data points with branch condition
      for (const ifDp of dp.ifDataPoints) {
        if (isBranchNode(ifDp)) {
          throw new Error("Nested branches are not supported");
        }
        const resolved = resolveSingleDataPoint(ifDp, i, registry);
        resolved._branchCondition = ifCondition;
        result.push(resolved);
      }

      // Resolve ELSE-branch data points with inverted condition
      for (const elseDp of dp.elseDataPoints) {
        if (isBranchNode(elseDp)) {
          throw new Error("Nested branches are not supported");
        }
        const resolved = resolveSingleDataPoint(elseDp, i, registry);
        resolved._branchCondition = elseCondition;
        result.push(resolved);
      }
    } else {
      result.push(resolveSingleDataPoint(dp, i, registry));
    }
  }

  return result;
}

// ── Main Generator ───────────────────────────────────────────────────────────

export function generateAgent(
  agentConfig: AgentConfig,
  rawDataPoints: RawDataPoint[],
  pathConfigs?: PathConfig[],
  defaults?: Record<string, DataPoint>,
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
    if (!p.dataPoints || p.dataPoints.length === 0) {
      throw new Error(`Path "${p.name}" has no data points`);
    }
    try {
      return { name: p.name, resolved: resolveDataPoints(p.dataPoints, defaults) };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Path "${p.name}": ${msg}`);
    }
  });

  // All resolved data points (flattened, for backward compat)
  const allResolved = resolvedPaths.flatMap((p) => p.resolved);

  // Generate IDs and positions for all paths
  const pathDataPoints = resolvedPaths.map((p) => p.resolved);
  const ids = generateIds(f, pathDataPoints);
  const pos = layoutPositions(pathDataPoints);

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

Once you know the caller's first name, use it in the opening and ending of the call, nowhere else.

Unless otherwise asked of you, do not repeat back what the caller said back to them.

Acknowledge by using the available short acknowledgments listed here:
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
          }))
        : undefined,
    ),
  );

  // Per-path nodes: transition + data chain
  resolvedPaths.forEach((rp, pathIdx) => {
    const pIds = ids.paths[pathIdx];
    const pPos = pos.paths[pathIdx];
    const pathLabel = isMultiPath ? rp.name : undefined;

    allNodes.push(buildTransitionNode(pIds, pPos, f, pathLabel));
    allNodes.push(
      ...buildDataChain(rp.resolved, pIds, pPos, ids.closeId, f, pathLabel),
    );
  });

  // Shared global + closing nodes
  const humanMode: HumanRequestMode = agentConfig.humanRequestMode || "callback";
  allNodes.push(buildFaqNode(faqKnowledgeBase, ids, pos, f, isMultiPath));
  allNodes.push(buildHumanRequestNode(ids, pos, f, humanMode));
  if (humanMode === "live_transfer") {
    allNodes.push(buildTransferCallNode(ids, pos, f));
    allNodes.push(buildTransferFailedNode(ids, pos, f));
  }
  allNodes.push(buildCloseNode(businessName, ids, pos, f));
  allNodes.push(...buildClosingSequence(ids, pos, f));
  allNodes.push(buildIrrelevantGuardrailNode(ids, pos, f));
  allNodes.push(buildEmergencyGuardrailNode(ids, pos, f));
  allNodes.push(buildPoliteHangupNode(ids, pos, f));
  allNodes.push(buildGuardrailEndNode(ids, pos));

  const conversationFlow = {
    version: 1,
    global_prompt: globalPrompt,
    start_node_id: ids.introId,
    start_speaker: "agent",
    tools: [],
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
