import {
  DATA_POINT_REGISTRY,
  type DataPoint,
  type RawDataPoint,
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
  type AgentConfig,
} from "./node-builders.js";

// ── Resolve Data Points ──────────────────────────────────────────────────────

export function resolveDataPoints(rawDataPoints: RawDataPoint[]): DataPoint[] {
  return rawDataPoints.map((dp, i) => {
    if (typeof dp === "string") {
      const entry = DATA_POINT_REGISTRY[dp];
      if (!entry) {
        throw new Error(
          `Unknown data point "${dp}". Available: ${Object.keys(DATA_POINT_REGISTRY).join(", ")}`,
        );
      }
      return { ...entry };
    }
    // Composite data points have a variables array instead of variableName
    if (dp.composite) {
      return dp as DataPoint;
    }
    if (!dp.variableName)
      throw new Error(`dataPoints[${i}] missing required field: variableName`);
    return {
      label:
        dp.label ||
        dp.variableName
          .replace(/_/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase()),
      variableName: dp.variableName,
      type: dp.type || "string",
      choices: dp.choices || [],
      description:
        dp.description ||
        `${dp.variableName}. If not mentioned, set to "Not Mentioned".`,
      conversationPrompt:
        dp.conversationPrompt ||
        `Ask the caller for their ${dp.variableName.replace(/_/g, " ")}.\n\nDo not give examples unless they are unsure, then you can provide them up to three examples.`,
      forwardCondition:
        dp.forwardCondition ||
        `The caller has provided their ${dp.variableName.replace(/_/g, " ")}`,
      finetuneExamples: dp.finetuneExamples || [],
      extractSuccessEquation: dp.extractSuccessEquation || [
        { left: `{{${dp.variableName}}}`, operator: "exists" },
        {
          left: `{{${dp.variableName}}}`,
          operator: "!=",
          right: "Not Mentioned",
        },
      ],
    };
  });
}

// ── Main Generator ───────────────────────────────────────────────────────────

export function generateAgent(
  agentConfig: AgentConfig,
  rawDataPoints: RawDataPoint[],
): { agent: Record<string, unknown>; resolved: DataPoint[] } {
  const { businessName, faqKnowledgeBase } = agentConfig;
  const f = makeIdFactory();
  const resolved = resolveDataPoints(rawDataPoints);
  const ids = generateIds(f, resolved);
  const pos = layoutPositions(resolved);

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

  const allNodes = [
    buildEndNode(ids, pos),
    buildIntroNode(agentConfig, ids, pos, f),
    buildTransitionNode(ids, pos, f),
    buildFaqNode(faqKnowledgeBase, ids, pos, f),
    buildHumanRequestNode(ids, pos, f),
    ...buildDataChain(resolved, ids, pos, f),
    buildCloseNode(businessName, ids, pos, f),
    ...buildClosingSequence(ids, pos, f),
    buildIrrelevantGuardrailNode(ids, pos, f),
    buildEmergencyGuardrailNode(ids, pos, f),
    buildPoliteHangupNode(ids, pos, f),
    buildGuardrailEndNode(ids, pos),
  ];

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

  return { agent, resolved };
}
