import type { DataPoint, FinetuneExample } from "./data-point-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface IdFactory {
  nextTs(): number;
  nodeId(): string;
  edgeId(): string;
  goBackId(): string;
}

export interface PathIds {
  transitionId: string;
  frontExtractId: string;
  routerId: string;
  chain: Array<{ convId: string; confirmId: string }>;
}

interface Ids {
  introId: string;
  endId: string;
  faqId: string;
  humanReqId: string;
  irrelevantGuardrailId: string;
  emergencyGuardrailId: string;
  politeHangupId: string;
  guardrailEndId: string;
  closeId: string;
  closingRemarksId: string;
  closingStatementId: string;
  paths: PathIds[];
}

interface Position {
  x: number;
  y: number;
}

export interface PathPositions {
  transition: Position;
  frontExtract: Position;
  router: Position;
  chain: Array<{ conv: Position; confirm: Position }>;
}

interface Positions {
  intro: Position;
  end: Position;
  faq: Position;
  humanReq: Position;
  irrelevantGuardrail: Position;
  emergencyGuardrail: Position;
  politeHangup: Position;
  guardrailEnd: Position;
  close: Position;
  paths: PathPositions[];
}

export interface AgentConfig {
  businessName: string;
  faqKnowledgeBase: string;
  introFinetuneExamples: FinetuneExample[];
}

export interface IntroPathConfig {
  name: string;
  transitionCondition: string;
}

// ── ID Factory ───────────────────────────────────────────────────────────────

function randomSuffix(len: number): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len)
    .padEnd(len, "0");
}

export function makeIdFactory(baseMs?: number): IdFactory {
  let counter = baseMs || Date.now();
  return {
    nextTs() {
      return ++counter;
    },
    nodeId() {
      return `node-${++counter}`;
    },
    edgeId() {
      return `edge-${++counter}-${randomSuffix(9)}`;
    },
    goBackId() {
      return `go-back-${++counter}`;
    },
  };
}

// ── Finetune Example Helper ──────────────────────────────────────────────────

function resolveFinetuneExamples(
  examples: FinetuneExample[] | undefined,
  defaultPositiveDestId: string,
  nodeMap: Record<string, string>,
  f: IdFactory,
) {
  return (examples || []).map((ex) => {
    const out: Record<string, unknown> = {
      transcript: ex.transcript,
      id: ex.id || `fe-${f.nextTs()}`,
    };
    if (ex.type === "positive") {
      const dest =
        ex.destination && nodeMap[ex.destination]
          ? nodeMap[ex.destination]
          : defaultPositiveDestId;
      out.destination_node_id = dest;
    }
    return out;
  });
}

// ── Pre-allocate IDs ─────────────────────────────────────────────────────────

export function generateIds(f: IdFactory, pathDataPoints: DataPoint[][]): Ids {
  const paths: PathIds[] = pathDataPoints.map((dps) => ({
    transitionId: f.nodeId(),
    frontExtractId: f.nodeId(),
    routerId: f.nodeId(),
    chain: dps.map(() => ({
      convId: f.nodeId(),
      confirmId: f.nodeId(),
    })),
  }));

  return {
    introId: f.nodeId(),
    endId: f.nodeId(),
    faqId: f.nodeId(),
    humanReqId: f.nodeId(),
    irrelevantGuardrailId: f.nodeId(),
    emergencyGuardrailId: f.nodeId(),
    politeHangupId: f.nodeId(),
    guardrailEndId: f.nodeId(),
    closeId: f.nodeId(),
    closingRemarksId: f.nodeId(),
    closingStatementId: f.nodeId(),
    paths,
  };
}

// ── Layout ───────────────────────────────────────────────────────────────────

const BASE_X = -954;
const STEP_X = 550;
const PATH_Y_OFFSET = 2000;

export function layoutPositions(pathDataPoints: DataPoint[][]): Positions {
  const paths: PathPositions[] = pathDataPoints.map((dps, pathIdx) => {
    const yBase = pathIdx * PATH_Y_OFFSET;
    return {
      transition: { x: -18, y: -400 + yBase },
      frontExtract: { x: -18, y: 0 + yBase },
      router: { x: -18, y: 450 + yBase },
      chain: dps.map((_, i) => ({
        conv: { x: BASE_X + i * STEP_X, y: 900 + yBase },
        confirm: { x: BASE_X + i * STEP_X, y: 1350 + yBase },
      })),
    };
  });

  const maxChainLen = Math.max(...pathDataPoints.map((dps) => dps.length));
  const lastX = BASE_X + (maxChainLen - 1) * STEP_X + STEP_X;
  const lastPathYBase = (pathDataPoints.length - 1) * PATH_Y_OFFSET;

  return {
    intro: { x: -18, y: -906 },
    end: { x: 1494, y: -882 },
    faq: { x: -1386, y: -1770 },
    humanReq: { x: -954, y: -1770 },
    irrelevantGuardrail: { x: -1386, y: -2490 },
    emergencyGuardrail: { x: -882, y: -2778 },
    politeHangup: { x: -1026, y: -2394 },
    guardrailEnd: { x: -666, y: -2346 },
    close: { x: lastX, y: 894 + lastPathYBase },
    paths,
  };
}

// ── Node Builders ────────────────────────────────────────────────────────────

export function buildEndNode(ids: Ids, pos: Positions) {
  return {
    name: "End Call",
    id: ids.endId,
    type: "end",
    speak_during_execution: false,
    display_position: pos.end,
  };
}

export function buildTransitionNode(
  pathIds: PathIds,
  pathPos: PathPositions,
  f: IdFactory,
  pathName?: string,
) {
  return {
    instruction: {
      type: "prompt",
      text: `The caller stated their situation, and you're about to note down the details. You can say something like

"alright let me grab the information to get you help"

Do not ask any questions here.`,
    },
    name: pathName ? `Transition (${pathName})` : "Conversation",
    edges: [],
    id: pathIds.transitionId,
    type: "conversation",
    display_position: pathPos.transition,
    skip_response_edge: {
      destination_node_id: pathIds.frontExtractId,
      id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: {
        type: "prompt",
        prompt: "Skip response",
      },
    },
  };
}

export function buildIntroNode(
  config: AgentConfig,
  ids: Ids,
  pos: Positions,
  f: IdFactory,
  pathConfigs?: IntroPathConfig[],
) {
  const isMultiPath = pathConfigs && pathConfigs.length > 1;

  const nodeMap: Record<string, string> = {
    __faq__: ids.faqId,
    __extract__: ids.paths[0].transitionId,
  };

  let edges;
  if (isMultiPath) {
    edges = pathConfigs!.map((p, i) => ({
      destination_node_id: ids.paths[i].transitionId,
      id: f.edgeId(),
      transition_condition: {
        type: "prompt",
        prompt: p.transitionCondition,
      },
    }));
  } else {
    edges = [
      {
        destination_node_id: ids.paths[0].transitionId,
        id: f.edgeId(),
        transition_condition: {
          type: "prompt",
          prompt:
            "The caller confirms forward intent with service, including wanting to sign up, get a quote, schedule service, or get started.",
        },
      },
    ];
  }

  return {
    finetune_conversation_examples: [],
    instruction: {
      type: "prompt",
      text: `Determine the reason for the caller's call.

Welcome the caller: "Thank you for calling ${config.businessName}, this is Anthony. How may I help you?"

If the caller greets you, reciprocate the sentiment and then ask how you can help them.

Stay in this node until the caller expresses clear intent to move forward with service. This includes:
- Wanting to sign up
- Wanting to schedule service
- Wanting a quote
- Wanting to get started

Do NOT leave this node if the caller is only asking questions. Let the Admin/FAQ global node handle those and return here.`,
    },
    name: "Intro",
    edges,
    start_speaker: "agent",
    finetune_transition_examples: resolveFinetuneExamples(
      config.introFinetuneExamples,
      ids.paths[0].transitionId,
      nodeMap,
      f,
    ),
    id: ids.introId,
    type: "conversation",
    display_position: pos.intro,
  };
}

export function buildFaqNode(
  faqKnowledgeBase: string,
  ids: Ids,
  pos: Positions,
  f: IdFactory,
  isMultiPath?: boolean,
) {
  // Multi-path: forward-intent goes to Intro so caller re-enters path routing
  // Single-path: forward-intent goes directly to transition (existing behavior)
  const forwardDestination = isMultiPath
    ? ids.introId
    : ids.paths[0].transitionId;

  return {
    instruction: {
      type: "prompt",
      text: `Your goal is to answer administrative and general questions briefly and accurately.

${faqKnowledgeBase}`,
    },
    name: "Admin/FAQ",
    edges: [
      {
        destination_node_id: forwardDestination,
        id: f.edgeId(),
        transition_condition: {
          type: "prompt",
          prompt:
            "The caller confirms forward intent with service, including wanting to sign up, get a quote, schedule service, or get started.",
        },
      },
    ],
    global_node_setting: {
      go_back_conditions: [
        {
          id: f.goBackId(),
          transition_condition: {
            type: "prompt",
            prompt: "You answered the caller's question.",
          },
        },
      ],
      condition:
        "Jump to this node when a customer has an admin/FAQ question regarding the business or its services.",
      positive_finetune_examples: [],
      negative_finetune_examples: [],
    },
    id: ids.faqId,
    type: "conversation",
    display_position: pos.faq,
  };
}

export function buildHumanRequestNode(ids: Ids, pos: Positions, f: IdFactory) {
  return {
    instruction: {
      type: "prompt",
      text: `The caller is requesting a human or live person.

1. Acknowledge the request calmly and professionally, saying they are not available at the moment.

2. Tell them they have the option to request a call back. Ask the caller if they want a call back.

If the caller refuses and repeats the request for a human, repeat that you cannot transfer the call.`,
    },
    name: "Human Request",
    edges: [
      {
        destination_node_id: ids.politeHangupId,
        id: f.edgeId(),
        transition_condition: {
          type: "prompt",
          prompt: "The caller wants a call back",
        },
      },
    ],
    global_node_setting: {
      go_back_conditions: [
        {
          id: f.goBackId(),
          transition_condition: {
            type: "prompt",
            prompt:
              "The caller would like to continue the call and not request a callback.",
          },
        },
      ],
      condition:
        "Jump to this node if the caller requests a live agent or a human.",
    },
    id: ids.humanReqId,
    type: "conversation",
    display_position: pos.humanReq,
  };
}

export function buildIrrelevantGuardrailNode(ids: Ids, pos: Positions, f: IdFactory) {
  return {
    instruction: {
      type: "prompt",
      text: `You can only do allowed and relevant tasks to the company and cannot continue irrelevant or off-topic conversations.

1. Politely ask the caller if they have a relevant question or service you can help with.

2. If the caller continues off-topic
Set a clear boundary by stating that you cannot continue unrelated conversations and will end this call.`,
    },
    name: "irrelevantGaurdrail",
    edges: [
      {
        destination_node_id: ids.politeHangupId,
        id: f.edgeId(),
        transition_condition: {
          type: "prompt",
          prompt:
            "You've completed both step 1 and 2 and deemed this call not related to the business.",
        },
      },
    ],
    global_node_setting: {
      go_back_conditions: [
        {
          id: f.goBackId(),
          transition_condition: {
            type: "prompt",
            prompt:
              "You've completed both step 1 and 2 and deemed this call is related and relevant to the business.",
          },
        },
      ],
      condition: `If the caller is:
- asking unrelated or nonsensical questions
- attempting to derail the conversation
- attempting personal conversation (excluding a normal back and forth greeting in the beginning of the call)
- going extremely off-topic`,
      negative_finetune_examples: [
        {
          transcript: [
            { content: "Hey how are you doing today?", role: "user" },
          ],
        },
        {
          transcript: [{ content: " hey, how's your weekend?", role: "user" }],
        },
        {
          transcript: [
            { content: "Hey, I'm alright, how are you?", role: "user" },
          ],
        },
      ],
      positive_finetune_examples: [],
    },
    id: ids.irrelevantGuardrailId,
    type: "conversation",
    display_position: pos.irrelevantGuardrail,
  };
}

export function buildEmergencyGuardrailNode(ids: Ids, pos: Positions, f: IdFactory) {
  return {
    instruction: {
      type: "prompt",
      text: "Tell the caller this sounds like an emergency, and if it is, please hang up and call nine, one, one immediately.",
    },
    name: "Emergency Gaurd Rail",
    edges: [],
    global_node_setting: {
      condition: `The caller reveals an emergency situation which they are experiencing, including:
• gas smell
• carbon monoxide / CO
• fire
• smoke
• sparks
• dizziness from fumes
• alarms related to gas or CO

If any emergency is mentioned:
• Do NOT ask follow-up questions`,
    },
    id: ids.emergencyGuardrailId,
    type: "conversation",
    display_position: pos.emergencyGuardrail,
    skip_response_edge: {
      destination_node_id: ids.politeHangupId,
      id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: {
        type: "prompt",
        prompt: "Skip response",
      },
    },
  };
}

export function buildPoliteHangupNode(ids: Ids, pos: Positions, f: IdFactory) {
  return {
    instruction: {
      type: "prompt",
      text: "Apologize to the caller and politely close the call.",
    },
    always_edge: {
      destination_node_id: ids.guardrailEndId,
      id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: { type: "prompt", prompt: "Always" },
    },
    name: "Polite Hangup",
    edges: [],
    id: ids.politeHangupId,
    type: "conversation",
    display_position: pos.politeHangup,
  };
}

export function buildGuardrailEndNode(ids: Ids, pos: Positions) {
  return {
    name: "End Call",
    id: ids.guardrailEndId,
    type: "end",
    speak_during_execution: false,
    display_position: pos.guardrailEnd,
  };
}

// ── Data Chain ───────────────────────────────────────────────────────────────

function toVarDefs(rdp: DataPoint) {
  if (rdp.composite && rdp.variables) {
    return rdp.variables.map((v) => {
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
    name: rdp.variableName,
    type: rdp.type,
    description: rdp.description,
  };
  if (rdp.type === "enum") def.choices = rdp.choices;
  return [def];
}

export function buildDataChain(
  resolvedDataPoints: DataPoint[],
  pathIds: PathIds,
  pathPos: PathPositions,
  closeId: string,
  f: IdFactory,
  pathName?: string,
) {
  const nodes: Record<string, unknown>[] = [];
  const suffix = pathName ? ` (${pathName})` : "";

  // Front-loaded Extract: capture all variables from caller's initial input
  const allVariableDefs = resolvedDataPoints.flatMap(toVarDefs);

  // In multi-path mode, add hidden _path_taken variable for post-call routing
  if (pathName) {
    allVariableDefs.push({
      name: "_path_taken",
      type: "string",
      description: `Always set to "${pathName}".`,
    });
  }

  nodes.push({
    variables: allVariableDefs,
    else_edge: {
      destination_node_id: pathIds.routerId,
      id: `${pathIds.frontExtractId}-else-edge`,
      transition_condition: { type: "prompt", prompt: "Else" },
    },
    name: `Extract All Variables${suffix}`,
    edges: [],
    finetune_transition_examples: [],
    id: pathIds.frontExtractId,
    type: "extract_dynamic_variables",
    display_position: pathPos.frontExtract,
  });

  // Variables Router: check each variable, route to first missing one
  const routerEdges = resolvedDataPoints.map((dp, i) => {
    if (dp.variableName === "phone_number") {
      return {
        destination_node_id: pathIds.chain[i].convId,
        id: f.edgeId(),
        transition_condition: {
          type: "equation",
          equations: [
            {
              left: `{{phone_number}}`,
              operator: "==",
              right: "Not Mentioned",
            },
            {
              left: `{{phone_number_collected}}`,
              operator: "!=",
              right: "true",
            },
          ],
          operator: "&&",
        },
      };
    }
    if (dp.composite && dp.variables) {
      const equations = dp.variables.flatMap((v) => [
        { left: `{{${v.variableName}}}`, operator: "not_exist" },
        { left: `{{${v.variableName}}}`, operator: "==", right: "Not Mentioned" },
      ]);
      return {
        destination_node_id: pathIds.chain[i].convId,
        id: f.edgeId(),
        transition_condition: {
          type: "equation",
          equations,
          operator: "||",
        },
      };
    }
    return {
      destination_node_id: pathIds.chain[i].convId,
      id: f.edgeId(),
      transition_condition: {
        type: "equation",
        equations: [
          { left: `{{${dp.variableName}}}`, operator: "not_exist" },
          {
            left: `{{${dp.variableName}}}`,
            operator: "==",
            right: "Not Mentioned",
          },
        ],
        operator: "||",
      },
    };
  });

  nodes.push({
    name: `Variables Router${suffix}`,
    edges: routerEdges,
    id: pathIds.routerId,
    else_edge: {
      destination_node_id: closeId,
      id: `${pathIds.routerId}-else-edge`,
      transition_condition: { type: "prompt", prompt: "Else" },
    },
    type: "branch",
    display_position: pathPos.router,
  });

  // Per-variable: Collect (conversation) + Confirm (extract) → back to router
  resolvedDataPoints.forEach((dp, i) => {
    const chainIds = pathIds.chain[i];
    const chainPos = pathPos.chain[i];

    // Tapered variable list: this variable + all remaining after it
    const remainingVarDefs = resolvedDataPoints.slice(i).flatMap(toVarDefs);

    // Collect node — ask for the variable
    nodes.push({
      name: dp.composite ? dp.label : `Collect ${dp.label}`,
      edges: [
        {
          destination_node_id: chainIds.confirmId,
          id: f.edgeId(),
          transition_condition: {
            type: "prompt",
            prompt: dp.forwardCondition,
          },
        },
      ],
      finetune_transition_examples: resolveFinetuneExamples(
        dp.finetuneExamples,
        chainIds.confirmId,
        {},
        f,
      ),
      finetune_conversation_examples: [],
      id: chainIds.convId,
      type: "conversation",
      display_position: chainPos.conv,
      instruction: { type: "prompt", text: dp.conversationPrompt },
    });

    // For phone_number, add a collected flag to break potential confirmation loops
    if (dp.variableName === "phone_number") {
      remainingVarDefs.push({
        name: "phone_number_collected",
        type: "boolean",
        description: "Always set to true",
      });
    }

    // Confirm node — extract this + all remaining variables, then route back to router
    nodes.push({
      variables: remainingVarDefs,
      else_edge: {
        destination_node_id: pathIds.routerId,
        id: `${chainIds.confirmId}-else-edge`,
        transition_condition: { type: "prompt", prompt: "Else" },
      },
      name: `Confirm ${dp.label}`,
      edges: [],
      id: chainIds.confirmId,
      type: "extract_dynamic_variables",
      display_position: chainPos.confirm,
    });
  });

  return nodes;
}

export function buildCloseNode(
  businessName: string,
  ids: Ids,
  pos: Positions,
  f: IdFactory,
) {
  return {
    instruction: {
      type: "prompt",
      text: `Thank the caller for all the information, and let them know our team at ${businessName} will reach out to get them set up as soon as possible.`,
    },
    always_edge: {
      destination_node_id: ids.closingRemarksId,
      id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: { type: "prompt", prompt: "Always" },
    },
    name: "Close",
    edges: [],
    id: ids.closeId,
    type: "conversation",
    display_position: pos.close,
  };
}

export function buildClosingSequence(
  ids: Ids,
  pos: Positions,
  f: IdFactory,
) {
  const lastX = pos.close.x;
  return [
    {
      instruction: {
        type: "prompt",
        text: "You are about to end the call. Do not ask any questions.\n\nThank them and tell them to have a wonderful day. ",
      },
      always_edge: {
        destination_node_id: ids.closingStatementId,
        id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
        transition_condition: { type: "prompt", prompt: "Always" },
      },
      name: "Closing Remarks",
      edges: [],
      id: ids.closingRemarksId,
      type: "conversation",
      display_position: { x: lastX, y: 1182 },
    },
    {
      instruction: {
        type: "static_text",
        text: "Alright, bye now!",
      },
      name: "Closing Statement",
      edges: [],
      id: ids.closingStatementId,
      type: "conversation",
      display_position: { x: lastX, y: 1494 },
      skip_response_edge: {
        destination_node_id: ids.endId,
        id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
        transition_condition: { type: "prompt", prompt: "Skip response" },
      },
    },
  ];
}

// ── Root Agent Assembly ──────────────────────────────────────────────────────

export function buildAgentRoot(
  businessName: string,
  conversationFlow: Record<string, unknown>,
) {
  return {
    agent_id: "",
    channel: "voice",
    last_modification_timestamp: Date.now(),
    agent_name: businessName,
    response_engine: {
      type: "conversation-flow",
      version: 1,
    },
    webhook_url:
      "https://servicecall-api-production.up.railway.app/retell/post-hook",
    webhook_timeout_ms: 15500,
    language: "en-US",
    data_storage_setting: "everything",
    opt_in_signed_url: false,
    end_call_after_silence_ms: 30000,
    version: 1,
    is_published: false,
    version_title: "",
    post_call_analysis_model: "gpt-5-mini",
    pii_config: { mode: "post_call", categories: [] },
    guardrail_config: {
      output_topics: [
        "harassment",
        "self_harm",
        "sexual_exploitation",
        "violence",
        "defense_and_national_security",
        "illicit_and_harmful_activity",
        "gambling",
        "regulated_professional_advice",
        "child_safety_and_exploitation",
      ],
      input_topics: ["platform_integrity_jailbreaking"],
    },
    analysis_successful_prompt:
      "Evaluate whether the agent seems to have a successful call with the user, where the agent finishes the task, and the call was complete without being cutoff.",
    analysis_summary_prompt:
      "Write a 1-3 sentence summary of the call based on the call transcript. Should capture the important information and actions taken during the call.",
    analysis_user_sentiment_prompt:
      "Evaluate user's sentiment, mood and satisfaction level.",
    handbook_config: {
      natural_filler_words: true,
      speech_normalization: false,
    },
    voice_id: "11labs-Ethan",
    voice_model: "eleven_turbo_v2",
    fallback_voice_ids: [],
    voice_temperature: 0.36,
    voice_speed: 1.12,
    volume: 1,
    enable_backchannel: false,
    backchannel_frequency: 0.2,
    backchannel_words: ["got it"],
    reminder_trigger_ms: 10000,
    reminder_max_count: 3,
    max_call_duration_ms: 655000,
    interruption_sensitivity: 0.89,
    ambient_sound: "coffee-shop",
    ambient_sound_volume: 0.95,
    responsiveness: 1,
    normalize_for_speech: false,
    begin_message_delay_ms: 2000,
    voicemail_option: { action: { type: "hangup" } },
    allow_user_dtmf: false,
    user_dtmf_options: {},
    post_call_analysis_data: [
      {
        type: "system-presets",
        name: "call_summary",
        description:
          "Write a 1-3 sentence summary of the call based on the call transcript. Should capture the important information and actions taken during the call.",
      },
      {
        type: "system-presets",
        name: "call_successful",
        description:
          "Evaluate whether the agent seems to have a successful call with the user, where the agent finishes the task, and the call was complete without being cutoff.",
      },
      {
        type: "system-presets",
        name: "user_sentiment",
        description:
          "Evaluate user's sentiment, mood and satisfaction level.",
      },
    ],
    conversationFlow,
  };
}
