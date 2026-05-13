import type { DataPoint, FinetuneExample, SendSmsAction } from "./data-point-registry.js";
import {
  NOT_MENTIONED,
  PHONE_COLLECTED_FLAG,
  PATH_TAKEN_VAR,
  isSendSmsAction,
} from "./data-point-registry.js";
import { renderTemplate } from "../build-notification.js";

// Stable tool id for the send_sms CustomTool registered in every flow's
// conversationFlow.tools[]. Function nodes generated for SMS actions
// reference this id via tool_id, which lets the parser identify them
// deterministically when round-tripping a published flow.
export const SEND_SMS_TOOL_ID = "send_sms";

// Public URL for the /retell/send-sms endpoint. Kept alongside the post-hook
// URL (line ~1222) so they share the same source of truth for the public host.
export const SEND_SMS_TOOL_URL =
  "https://servicecall-api-production.up.railway.app/retell/send-sms";

// Default templates for the four closing nodes. Use {{business_name}} — substituted on the way to Retell.
//
// Closing chain: Close → Close Question → Closing Remarks → Closing Statement → End.
// Close says thanks only. Close Question asks "anything else?" and lets the
// Admin/FAQ global node intercept real questions (then go-back returns here).
// Closing Remarks delivers the final goodbye line. Closing Statement is
// spoken verbatim and skips the response cycle into End.
export const DEFAULT_CLOSE_PROMPT = `Thank the caller for all the information, and let them know our team at {{business_name}} will reach out to get them set up as soon as possible.`;
export const DEFAULT_CLOSE_QUESTION_PROMPT = `Ask the caller exactly: "Is there anything else I can help you with?"`;
export const DEFAULT_CLOSING_REMARKS_PROMPT = `You are about to end the call. Do not ask any questions.\n\nThank them and tell them to have a wonderful day. `;
export const DEFAULT_CLOSING_STATEMENT_TEXT = `Alright, bye now!`;

// Generic question patterns that should route the caller to the Admin/FAQ
// global node instead of staying in the intro / advancing to data collection.
// Vertical-agnostic — every new agent gets these as the FAQ classifier's
// positive training set. Empty agent content because Retell only needs the
// user utterance for routing.
export const FAQ_GLOBAL_POSITIVE_EXAMPLES: FinetuneExample[] = [
  // Pricing / cost
  { transcript: [{ content: "How much is a service call?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "What does it cost?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "How much do you charge for an estimate?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "What's your hourly rate?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Is there a fee just to come out?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Can you give me a ballpark price?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Before I commit — what am I looking at price-wise?", role: "user" }, { content: "", role: "agent" }] },
  // Hours / availability
  { transcript: [{ content: "Are you open on weekends?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "What time do you close?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Do you do after-hours service?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Are you open today?", role: "user" }, { content: "", role: "agent" }] },
  // Services offered / coverage
  { transcript: [{ content: "Do you work on Carrier units?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Do you do installations or just repairs?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Do you handle commercial buildings?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Do you service my area?", role: "user" }, { content: "", role: "agent" }] },
  // Warranty / credentials / trust
  { transcript: [{ content: "Are you licensed and insured?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Do you offer any warranty on repairs?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "How long have you been in business?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Is my unit still under warranty?", role: "user" }, { content: "", role: "agent" }] },
  // Logistics / process
  { transcript: [{ content: "How does this work?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "What should I expect when the technician arrives?", role: "user" }, { content: "", role: "agent" }] },
  { transcript: [{ content: "Do I need to be home for the appointment?", role: "user" }, { content: "", role: "agent" }] },
];

// Spoken right before a per-path live transfer kicks off.
export const DEFAULT_PRE_TRANSFER_PROMPT = `Thanks for the information. Hold on a moment — connecting you to our team at {{business_name}} now.`;

// Spoken when a live transfer fails to connect (Live Transfer Recovery node).
export const DEFAULT_LIVE_TRANSFER_RECOVERY_PROMPT = `Sorry about that. It looks like our staff members are on the floor helping customers. Let us give you a call back. We'll call you back as soon as possible.`;

// Shared warm-transfer screener agent. Used as transfer_agent for every live
// transfer node we emit (global Human Request transfer + per-path outcomes).
// Bump the fallback when a new published version exists; production should pull
// the latest from Retell via getWarmTransferAgentVersion().
export const WARM_TRANSFER_AGENT_ID = "agent_1d0e26bb0cbe39bc9ea3214984";
export const WARM_TRANSFER_AGENT_VERSION_FALLBACK = 5;

export function buildWarmTransferOption(agentVersion?: number) {
  return {
    agentic_transfer_config: {
      transfer_agent: {
        agent_id: WARM_TRANSFER_AGENT_ID,
        agent_version: agentVersion ?? WARM_TRANSFER_AGENT_VERSION_FALLBACK,
      },
      transfer_timeout_ms: 30000,
      action_on_timeout: "cancel_transfer",
    },
    enable_bridge_audio_cue: false,
    type: "agentic_warm_transfer",
    agent_detection_timeout_ms: 10000,
    on_hold_music: "relaxing_sound",
    show_transferee_as_caller: false,
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface IdFactory {
  nextTs(): number;
  nodeId(): string;
  edgeId(): string;
  goBackId(): string;
}

export interface SmsActionIds {
  funcId: string;
  markSentId: string;
  /** Boolean dynamic-variable name the Mark Sent node flips to "true" after
   *  the function call returns. The Variables Router gates the SMS edge on
   *  (not_exist || != "true") so the action fires exactly once. Unique per
   *  action across the agent. */
  sentinelVar: string;
}

export interface PathIds {
  transitionId: string;
  frontExtractId: string;
  routerId: string;
  chain: Array<{ convId: string; confirmId: string }>;
  /** Parallel to the SendSmsAction items in ResolvedPath.resolved, in source
   *  order. Empty when the path has no SMS actions. */
  smsActions: SmsActionIds[];
  preTransferId?: string;
  transferCallId?: string;
  // Callback paths in multi-path agents own their own Close node.
  // Single-path agents and transfer paths leave this undefined and use
  // the shared ids.closeId / Pre-Transfer respectively.
  closeId?: string;
}

export type HumanRequestMode = "live_transfer" | "callback";

interface Ids {
  introId: string;
  endId: string;
  faqId: string;
  humanReqId: string;
  transferCallId: string;
  transferFailedId: string;
  irrelevantGuardrailId: string;
  emergencyGuardrailId: string;
  politeHangupId: string;
  guardrailEndId: string;
  closeId: string;
  closeQuestionId: string;
  closingRemarksId: string;
  closingStatementId: string;
  paths: PathIds[];
}

interface Position {
  x: number;
  y: number;
}

export interface SmsActionPositions {
  func: Position;
  markSent: Position;
}

export interface PathPositions {
  transition: Position;
  frontExtract: Position;
  router: Position;
  chain: Array<{ conv: Position; confirm: Position }>;
  /** Parallel to PathIds.smsActions. */
  smsActions: SmsActionPositions[];
  preTransfer?: Position;
  transferCall?: Position;
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
  closeQuestion: Position;
  paths: PathPositions[];
}

export interface AgentConfig {
  businessName: string;
  faqKnowledgeBase: string;
  introFinetuneExamples: FinetuneExample[];
  humanRequestMode?: HumanRequestMode;
  closePrompt?: string;
  // Per-path overrides for the Close prompt (multi-path agents only).
  // Map keys are path names. Paths missing from the map fall back to
  // closePrompt (the global default).
  pathClosePrompts?: Record<string, string>;
  // "Is there anything else…?" prompt spoken in the dedicated Close Question
  // node that sits between Close and Closing Remarks. One per agent (not
  // per-path) so caller-facing wording stays consistent regardless of how
  // they entered the closing chain.
  closeQuestionPrompt?: string;
  closingRemarksPrompt?: string;
  closingStatementText?: string;
  liveTransferRecoveryPrompt?: string;
  warmTransferAgentVersion?: number;
}

export interface IntroPathConfig {
  name: string;
  transitionCondition: string;
  /** Positive examples that should route the caller to this path. Folded
   *  into the intro node's finetune_transition_examples with destination
   *  set to this path's transitionId. */
  transitionFinetuneExamples?: FinetuneExample[];
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

export function generateIds(
  f: IdFactory,
  pathSequences: Array<Array<DataPoint | SendSmsAction>>,
  pathEndModes?: Array<"callback" | "transfer">,
): Ids {
  // Multi-path callback agents get a per-path Close node so the close prompt
  // can differ per path. Single-path agents keep the shared ids.closeId for
  // layout/backwards-compat.
  const isMultiPath = pathSequences.length > 1;
  // Globally-unique counter for sentinel variable names, so two SMS actions
  // in the same agent never collide on a name like is_sms_sent_1.
  let smsSentinelCounter = 0;
  const paths: PathIds[] = pathSequences.map((seq, idx) => {
    const isTransfer = pathEndModes?.[idx] === "transfer";
    const dps = seq.filter((it): it is DataPoint => !isSendSmsAction(it));
    const actions = seq.filter((it): it is SendSmsAction => isSendSmsAction(it));
    return {
      transitionId: f.nodeId(),
      frontExtractId: f.nodeId(),
      routerId: f.nodeId(),
      chain: dps.map(() => ({
        convId: f.nodeId(),
        confirmId: f.nodeId(),
      })),
      smsActions: actions.map(() => ({
        funcId: f.nodeId(),
        markSentId: f.nodeId(),
        sentinelVar: `is_sms_sent_${++smsSentinelCounter}`,
      })),
      ...(isTransfer
        ? { preTransferId: f.nodeId(), transferCallId: f.nodeId() }
        : {}),
      ...(!isTransfer && isMultiPath ? { closeId: f.nodeId() } : {}),
    };
  });

  return {
    introId: f.nodeId(),
    endId: f.nodeId(),
    faqId: f.nodeId(),
    humanReqId: f.nodeId(),
    transferCallId: f.nodeId(),
    transferFailedId: f.nodeId(),
    irrelevantGuardrailId: f.nodeId(),
    emergencyGuardrailId: f.nodeId(),
    politeHangupId: f.nodeId(),
    guardrailEndId: f.nodeId(),
    closeId: f.nodeId(),
    closeQuestionId: f.nodeId(),
    closingRemarksId: f.nodeId(),
    closingStatementId: f.nodeId(),
    paths,
  };
}

// ── Layout ───────────────────────────────────────────────────────────────────

const BASE_X = -954;
const STEP_X = 550;
const PATH_Y_OFFSET = 2000;

export function layoutPositions(
  pathSequences: Array<Array<DataPoint | SendSmsAction>>,
  pathEndModes?: Array<"callback" | "transfer">,
): Positions {
  // SMS-action layout sits below the Collect/Confirm row at the source-order
  // column. Two stacked nodes: function (send_sms) above Mark Sent, both off
  // to the side so they don't visually crowd the DP chain in the editor.
  const SMS_Y_FUNC = 1800;
  const SMS_Y_MARK = 2250;

  const paths: PathPositions[] = pathSequences.map((seq, pathIdx) => {
    const yBase = pathIdx * PATH_Y_OFFSET;
    const isTransfer = pathEndModes?.[pathIdx] === "transfer";

    const dpPositions: Array<{ conv: Position; confirm: Position }> = [];
    const smsPositions: SmsActionPositions[] = [];
    seq.forEach((item, i) => {
      if (isSendSmsAction(item)) {
        smsPositions.push({
          func: { x: BASE_X + i * STEP_X, y: SMS_Y_FUNC + yBase },
          markSent: { x: BASE_X + i * STEP_X, y: SMS_Y_MARK + yBase },
        });
      } else {
        const dpIdx = dpPositions.length;
        dpPositions.push({
          conv: { x: BASE_X + dpIdx * STEP_X, y: 900 + yBase },
          confirm: { x: BASE_X + dpIdx * STEP_X, y: 1350 + yBase },
        });
      }
    });

    return {
      transition: { x: -18, y: -400 + yBase },
      frontExtract: { x: -18, y: 0 + yBase },
      router: { x: -18, y: 450 + yBase },
      chain: dpPositions,
      smsActions: smsPositions,
      ...(isTransfer
        ? {
            preTransfer: { x: -18, y: 1800 + yBase },
            transferCall: { x: 540, y: 1800 + yBase },
          }
        : {}),
    };
  });

  const chainLengths = pathSequences.map((seq) => seq.filter((it) => !isSendSmsAction(it)).length);
  const maxChainLen = chainLengths.length > 0 ? Math.max(...chainLengths) : 0;
  const lastX = BASE_X + (maxChainLen - 1) * STEP_X + STEP_X;
  const lastPathYBase = (pathSequences.length - 1) * PATH_Y_OFFSET;

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
    closeQuestion: { x: lastX, y: 1038 + lastPathYBase },
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
  // Optional override for the skip_response_edge destination. Used when the
  // path has no data points — the caller passes the terminal node id (close
  // or pre-transfer) so the transition skips straight there.
  targetId?: string,
) {
  return {
    instruction: {
      type: "prompt",
      text: `Empathetically acknowledge the caller's situation, then say something like

"let me grab the information"

Do not ask any questions here.`,
    },
    name: pathName ? `Transition (${pathName})` : "Conversation",
    edges: [],
    id: pathIds.transitionId,
    type: "conversation",
    display_position: pathPos.transition,
    skip_response_edge: {
      destination_node_id: targetId ?? pathIds.frontExtractId,
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

Do not assume their name until they tell you explicitly.

Do NOT leave this node if the caller is only asking questions. Let the Admin/FAQ global node handle those and return here.`,
    },
    name: "Intro",
    edges,
    start_speaker: "agent",
    finetune_transition_examples: [
      ...resolveFinetuneExamples(
        config.introFinetuneExamples,
        ids.paths[0].transitionId,
        nodeMap,
        f,
      ),
      // Per-path positive examples: each is a "this caller wants path X"
      // training utterance. Folded into the intro node's single finetune
      // array because Retell expects all transition examples on the source
      // node, with destination_node_id distinguishing where each leads.
      ...(pathConfigs || []).flatMap((p, i) =>
        (p.transitionFinetuneExamples || []).map((ex) => ({
          transcript: ex.transcript,
          id: ex.id || `fe-${f.nextTs()}`,
          destination_node_id: ids.paths[i].transitionId,
        })),
      ),
    ],
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
          prompt: "You answered the caller's question.",
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
      positive_finetune_examples: FAQ_GLOBAL_POSITIVE_EXAMPLES.map((ex) => ({
        transcript: ex.transcript,
      })),
      negative_finetune_examples: [],
    },
    id: ids.faqId,
    type: "conversation",
    display_position: pos.faq,
  };
}

export function buildHumanRequestNode(
  ids: Ids,
  pos: Positions,
  f: IdFactory,
  mode: HumanRequestMode = "callback",
) {
  if (mode === "live_transfer") {
    // Agent acknowledges and immediately transfers
    return {
      instruction: {
        type: "prompt",
        text: `The caller is requesting a human or live person.\n\nAcknowledge and tell them you will transfer the call.`,
      },
      name: "Human Request",
      edges: [],
      global_node_setting: {
        condition:
          "Jump to this node if the caller requests a live agent or a human.",
        negative_finetune_examples: [],
        positive_finetune_examples: [
          {
            transcript: [
              { content: "can I talk to the supervisor?", role: "user" },
              { content: "", role: "agent" },
            ],
          },
        ],
      },
      id: ids.humanReqId,
      type: "conversation",
      display_position: pos.humanReq,
      skip_response_edge: {
        destination_node_id: ids.transferCallId,
        id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
        transition_condition: {
          type: "prompt",
          prompt: "Skip response",
        },
      },
    };
  }

  // Default: callback mode
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

export function buildTransferCallNode(
  ids: Ids,
  pos: Positions,
  f: IdFactory,
  warmTransferAgentVersion?: number,
) {
  return {
    custom_sip_headers: {},
    transfer_destination: {
      type: "predefined",
      number: "{{dispatch_number}}",
    },
    edge: {
      destination_node_id: ids.transferFailedId,
      id: f.edgeId(),
      transition_condition: {
        type: "prompt",
        prompt: "Transfer failed",
      },
    },
    name: "Transfer Call",
    ignore_e164_validation: false,
    id: ids.transferCallId,
    transfer_option: buildWarmTransferOption(warmTransferAgentVersion),
    type: "transfer_call",
    speak_during_execution: false,
    display_position: { x: pos.humanReq.x + 360, y: pos.humanReq.y + 96 },
  };
}

// ── Per-path transfer (used when a path's end mode is "transfer") ────────────

export function buildPreTransferNode(
  pathIds: PathIds,
  pathPos: PathPositions,
  agentConfig: AgentConfig,
  pathLabel: string | undefined,
  f: IdFactory,
) {
  if (
    !pathIds.preTransferId ||
    !pathIds.transferCallId ||
    !pathPos.preTransfer
  ) {
    throw new Error("buildPreTransferNode: pathIds/pos missing transfer slots");
  }
  const text = renderTemplate(DEFAULT_PRE_TRANSFER_PROMPT, {
    business_name: agentConfig.businessName,
  });
  return {
    instruction: { type: "prompt", text },
    always_edge: {
      destination_node_id: pathIds.transferCallId,
      id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: { type: "prompt", prompt: "Always" },
    },
    name: pathLabel ? `Pre-Transfer (${pathLabel})` : "Pre-Transfer",
    edges: [],
    id: pathIds.preTransferId,
    type: "conversation",
    display_position: pathPos.preTransfer,
  };
}

export function buildPerPathTransferCallNode(
  pathIds: PathIds,
  pathPos: PathPositions,
  ids: Ids,
  resolvedNumber: string,
  pathLabel: string | undefined,
  f: IdFactory,
  warmTransferAgentVersion?: number,
) {
  if (!pathIds.transferCallId || !pathPos.transferCall) {
    throw new Error(
      "buildPerPathTransferCallNode: pathIds/pos missing transfer slots",
    );
  }
  return {
    custom_sip_headers: {},
    transfer_destination: { type: "predefined", number: resolvedNumber },
    edge: {
      destination_node_id: ids.transferFailedId,
      id: f.edgeId(),
      transition_condition: { type: "prompt", prompt: "Transfer failed" },
    },
    name: pathLabel ? `Transfer Call (${pathLabel})` : "Transfer Call",
    ignore_e164_validation: false,
    id: pathIds.transferCallId,
    transfer_option: buildWarmTransferOption(warmTransferAgentVersion),
    type: "transfer_call",
    speak_during_execution: false,
    display_position: pathPos.transferCall,
  };
}

export function buildLiveTransferRecoveryNode(
  agentConfig: AgentConfig,
  ids: Ids,
  pos: Positions,
  f: IdFactory,
) {
  const template =
    agentConfig.liveTransferRecoveryPrompt ??
    DEFAULT_LIVE_TRANSFER_RECOVERY_PROMPT;
  return {
    instruction: {
      type: "prompt",
      text: renderTemplate(template, {
        business_name: agentConfig.businessName,
      }),
    },
    always_edge: {
      destination_node_id: ids.closingRemarksId,
      id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: { type: "prompt", prompt: "Always" },
    },
    model_choice: {
      type: "cascading",
      model: "gpt-4.1",
      high_priority: true,
    },
    name: "Live Transfer Recovery",
    edges: [],
    id: ids.transferFailedId,
    type: "conversation",
    display_position: { x: pos.humanReq.x + 720, y: pos.humanReq.y - 96 },
  };
}

export function buildIrrelevantGuardrailNode(
  ids: Ids,
  pos: Positions,
  f: IdFactory,
) {
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

export function buildEmergencyGuardrailNode(
  ids: Ids,
  pos: Positions,
  f: IdFactory,
) {
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

// ── Send SMS: tool registration + node pair ──────────────────────────────────

/**
 * Registers the send_sms CustomTool on a conversation flow. The tool posts to
 * /retell/send-sms with an Authorization Bearer header; the endpoint authenticates
 * via API_KEY, falls back to call.from_number when `to` is omitted, and logs every
 * send to MongoDB outbound_messages (see src/routes/retell/send-sms.ts).
 *
 * Returning JSON shapes: { success: true, result } on 200, { success: false, error }
 * on non-200. Either way the SMS-action's Mark Sent extract node flips the sentinel
 * variable so the Variables Router never re-fires the same action in one call.
 */
export function buildSendSmsTool(apiKey: string) {
  return {
    type: "custom",
    tool_id: SEND_SMS_TOOL_ID,
    name: SEND_SMS_TOOL_ID,
    url: SEND_SMS_TOOL_URL,
    method: "POST",
    description:
      "Send an SMS to the caller. Only invoked by deterministic flow nodes — do not call from conversational tool use.",
    headers: { Authorization: `Bearer ${apiKey}` },
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "SMS body to send. Max 1600 characters.",
        },
        to: {
          type: "string",
          description:
            "Recipient phone in E.164 format. Omit to send to the caller's number (call.from_number).",
        },
      },
      required: ["message"],
    },
    speak_during_execution: false,
    speak_after_execution: false,
    timeout_ms: 10000,
  };
}

/**
 * Builds the two-node pair for a single SMS action:
 *   1. Function node — invokes the send_sms tool with the configured template.
 *   2. Mark Sent extract node — flips the per-action sentinel variable to "true".
 *
 * Both nodes route back to the path's Variables Router. Failure-path of the
 * function node also goes through Mark Sent so a Twilio error doesn't trap
 * the call in a router→function→router→function loop — the action fires
 * exactly once, success or not. Errors are already logged in outbound_messages.
 */
export function buildSendSmsNode(
  action: SendSmsAction,
  sIds: SmsActionIds,
  sPos: SmsActionPositions,
  routerId: string,
  pathSuffix: string,
  f: IdFactory,
): Record<string, unknown>[] {
  const displayName = action.name ?? "Send SMS";
  // Retell sees args_json in the instruction prompt and assembles the tool
  // call payload from it. Using static_text gives a single deterministic call
  // — the LLM doesn't get to pick what to send. {{var}} substitution happens
  // before Retell forwards the request to our endpoint, so collected dynamic
  // variables like {{phone_number}} or {{quote_id}} land in the SMS body.
  const argsObj: Record<string, unknown> = { message: action.template };
  if (action.to) argsObj.to = action.to;
  const argsJson = JSON.stringify(argsObj);

  const funcNode = {
    id: sIds.funcId,
    type: "function",
    tool_id: SEND_SMS_TOOL_ID,
    tool_type: "local",
    wait_for_result: true,
    name: `${displayName}${pathSuffix}`,
    instruction: {
      type: "static_text",
      text: `Call send_sms with: ${argsJson}`,
    },
    display_position: sPos.func,
    edges: [
      {
        id: f.edgeId(),
        transition_condition: { type: "prompt", prompt: "Tool call succeeded" },
        destination_node_id: sIds.markSentId,
      },
    ],
    // Failure route also goes to Mark Sent so the sentinel still flips and the
    // call doesn't retry. The Twilio failure is logged in outbound_messages.
    else_edge: {
      id: f.edgeId(),
      transition_condition: { type: "prompt", prompt: "Tool call failed" },
      destination_node_id: sIds.markSentId,
    },
  };

  // Mark Sent: an extract_dynamic_variables node whose only purpose is to flip
  // the sentinel boolean to "true". Mirrors how phone_collected_flag works on
  // the phone DP's Confirm — the description "Always set to true" tells the
  // LLM to set the variable without needing a caller turn.
  const markSentNode = {
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
    name: `Mark ${displayName} Sent${pathSuffix}`,
    edges: [],
    id: sIds.markSentId,
    type: "extract_dynamic_variables",
    display_position: sPos.markSent,
  };

  return [funcNode, markSentNode];
}

export function buildDataChain(
  resolvedSequence: Array<DataPoint | SendSmsAction>,
  pathIds: PathIds,
  pathPos: PathPositions,
  closeId: string,
  f: IdFactory,
  pathName?: string,
) {
  // Split the union sequence into DP-only / SMS-only views aligned with
  // pathIds.chain and pathIds.smsActions, then keep a parallel index mapper
  // so router-edge construction can look up the right id slot per item.
  const dpItems = resolvedSequence.filter((it): it is DataPoint => !isSendSmsAction(it));
  const smsItems = resolvedSequence.filter((it): it is SendSmsAction => isSendSmsAction(it));
  if (dpItems.length !== pathIds.chain.length) {
    throw new Error(
      `buildDataChain: data point count (${dpItems.length}) does not match allocated chain IDs (${pathIds.chain.length})`,
    );
  }
  if (smsItems.length !== pathIds.smsActions.length) {
    throw new Error(
      `buildDataChain: SMS action count (${smsItems.length}) does not match allocated SMS ids (${pathIds.smsActions.length})`,
    );
  }

  // Per-source-index lookups: dpAt[i] / smsAt[i] return the sub-index into
  // the respective id arrays, or -1 if the item at i isn't of that kind.
  const dpAt: number[] = new Array(resolvedSequence.length).fill(-1);
  const smsAt: number[] = new Array(resolvedSequence.length).fill(-1);
  {
    let dpCursor = 0;
    let smsCursor = 0;
    resolvedSequence.forEach((it, i) => {
      if (isSendSmsAction(it)) smsAt[i] = smsCursor++;
      else dpAt[i] = dpCursor++;
    });
  }

  const nodes: Record<string, unknown>[] = [];
  const suffix = pathName ? ` (${pathName})` : "";

  // Front-loaded Extract: capture all DP variables from the caller's initial
  // input. SMS sentinel vars are NOT registered here — they're flipped only
  // by their Mark Sent nodes and the router uses not_exist as the initial gate.
  const allVariableDefs = dpItems.flatMap(toVarDefs);

  // In multi-path mode, add hidden _path_taken variable for post-call routing
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

  // Variables Router: walk the source sequence and produce one edge per item
  // (DPs gated on "var still missing", SMS actions gated on "sentinel not yet
  // flipped to true"). Source order = router-edge order, and Retell evaluates
  // router edges first-match-wins, so an SMS action between DP1 and DP2 only
  // fires once DP1 is collected.
  // Orphan data points are extract-only — skip them in the router.
  const routerEdges: Record<string, unknown>[] = [];
  resolvedSequence.forEach((item, i) => {
    if (isSendSmsAction(item)) {
      const sIds = pathIds.smsActions[smsAt[i]];
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
      return;
    }

    const dp = item;
    if (dp.orphan) return;
    let missingEquations: any[];
    let missingOperator: string;

    if (dp.variableName === "phone_number") {
      missingEquations = [
        {
          left: `{{phone_number}}`,
          operator: "==",
          right: NOT_MENTIONED,
        },
        {
          left: `{{${PHONE_COLLECTED_FLAG}}}`,
          operator: "!=",
          right: "true",
        },
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
        {
          left: `{{${dp.variableName}}}`,
          operator: "==",
          right: NOT_MENTIONED,
        },
      ];
      missingOperator = "||";
    }

    const dpIdx = dpAt[i];

    // If this data point is inside a branch, AND all branch conditions
    if (dp._branchConditions && dp._branchConditions.length > 0) {
      const branchEqs: any[] = [];
      for (const bc of dp._branchConditions) {
        branchEqs.push({
          left: `{{${bc.variable}}}`,
          operator: bc.operator,
          right: bc.value,
        });
        // Guard ELSE conditions (!=) against sentinel values so they
        // don't fire when the variable is "Not Mentioned" or "Caller Doesn't Know"
        if (bc.operator === "!=") {
          branchEqs.push(
            {
              left: `{{${bc.variable}}}`,
              operator: "!=",
              right: NOT_MENTIONED,
            },
            {
              left: `{{${bc.variable}}}`,
              operator: "!=",
              right: "Caller Doesn't Know",
            },
          );
        }
      }
      routerEdges.push({
        destination_node_id: pathIds.chain[dpIdx].convId,
        id: f.edgeId(),
        transition_condition: {
          type: "equation",
          equations: [...missingEquations, ...branchEqs],
          operator: "&&",
        },
      });
      return;
    }

    routerEdges.push({
      destination_node_id: pathIds.chain[dpIdx].convId,
      id: f.edgeId(),
      transition_condition: {
        type: "equation",
        equations: missingEquations,
        operator: missingOperator,
      },
    });
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

  // Emit SMS-action node pairs: Function (send_sms) → Mark Sent → Router.
  smsItems.forEach((action, smsIdx) => {
    const sIds = pathIds.smsActions[smsIdx];
    const sPos = pathPos.smsActions[smsIdx];
    nodes.push(...buildSendSmsNode(action, sIds, sPos, pathIds.routerId, suffix, f));
  });

  // Per-variable: Collect (conversation) + Confirm (extract) → back to router
  // Orphan data points are extract-only — no Collect+Confirm nodes needed.
  dpItems.forEach((dp, i) => {
    if (dp.orphan) return;
    const chainIds = pathIds.chain[i];
    const chainPos = pathPos.chain[i];

    // Variable list for this Confirm extract:
    //   • Non-orphan dps taper down the chain — once a normal var has been
    //     collected, it falls off subsequent extracts so the LLM doesn't
    //     re-prompt for it.
    //   • Orphan (extract-only) dps persist in every NON-composite Confirm
    //     extract. The agent never asks for them, so we want to give the
    //     caller every chance to surface one — but we exclude composite
    //     Confirms from this persistence because the parser can't otherwise
    //     distinguish a composite's true sub-vars from injected orphans
    //     (they live in the same variables array). Composites are usually
    //     atomic (one prompt covers a tightly-scoped Q&A) so the lost
    //     capture window is minor.
    const taperedNonOrphans = dpItems.slice(i).filter((d) => !d.orphan);
    const persistentOrphans = dp.composite ? [] : dpItems.filter((d) => d.orphan);
    const remainingVarDefs = [...taperedNonOrphans, ...persistentOrphans].flatMap(toVarDefs);

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
        name: PHONE_COLLECTED_FLAG,
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
  agentConfig: AgentConfig,
  ids: Ids,
  pos: Positions,
  f: IdFactory,
  overrides?: {
    nodeId?: string;
    pathName?: string;
    promptText?: string;
    displayPosition?: Position;
  },
) {
  // Per-path build: caller supplies pathName + own nodeId. The single-Close
  // legacy build leaves overrides undefined and uses ids.closeId / "Close".
  const template =
    overrides?.promptText ??
    (overrides?.pathName
      ? agentConfig.pathClosePrompts?.[overrides.pathName]
      : undefined) ??
    agentConfig.closePrompt ??
    DEFAULT_CLOSE_PROMPT;
  const name = overrides?.pathName ? `Close (${overrides.pathName})` : "Close";
  return {
    instruction: {
      type: "prompt",
      text: renderTemplate(template, {
        business_name: agentConfig.businessName,
      }),
    },
    always_edge: {
      // Close always flows to the Close Question node — Close just thanks the
      // caller, Close Question asks "anything else?" and waits.
      destination_node_id: ids.closeQuestionId,
      id: `always-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: { type: "prompt", prompt: "Always" },
    },
    name,
    edges: [],
    id: overrides?.nodeId ?? ids.closeId,
    type: "conversation",
    display_position: overrides?.displayPosition ?? pos.close,
    // Block interruption on the Close node so the closing acknowledgement
    // ("thank you for the info, our technician will reach out…") plays
    // through cleanly even if the caller speaks. Retell treats this as a
    // per-node override of the agent-level global; 0 = no interruption.
    interruption_sensitivity: 0,
  };
}

// "Is there anything else I can help you with?" — sits between Close and
// Closing Remarks. The Admin/FAQ global node intercepts real questions
// automatically (its go_back_conditions returns the caller here once
// answered). The single explicit edge below moves them on when they say no.
export function buildCloseQuestionNode(
  agentConfig: AgentConfig,
  ids: Ids,
  pos: Positions,
  f: IdFactory,
) {
  const template = agentConfig.closeQuestionPrompt ?? DEFAULT_CLOSE_QUESTION_PROMPT;
  return {
    instruction: {
      type: "prompt",
      text: renderTemplate(template, {
        business_name: agentConfig.businessName,
      }),
    },
    name: "Close Question",
    edges: [
      {
        destination_node_id: ids.closingRemarksId,
        id: f.edgeId(),
        transition_condition: {
          type: "prompt",
          prompt: "The caller has no more questions",
        },
      },
    ],
    id: ids.closeQuestionId,
    type: "conversation",
    display_position: pos.closeQuestion,
  };
}

export function buildClosingSequence(
  agentConfig: AgentConfig,
  ids: Ids,
  pos: Positions,
  f: IdFactory,
) {
  const lastX = pos.close.x;
  const remarksTemplate =
    agentConfig.closingRemarksPrompt ?? DEFAULT_CLOSING_REMARKS_PROMPT;
  const statementTemplate =
    agentConfig.closingStatementText ?? DEFAULT_CLOSING_STATEMENT_TEXT;
  const vars = { business_name: agentConfig.businessName };
  return [
    {
      instruction: {
        type: "prompt",
        text: renderTemplate(remarksTemplate, vars),
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
        text: renderTemplate(statementTemplate, vars),
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
      echo_verification: true,
      speech_normalization: true,
      // Warmth defaults (propagated from Home Heating after live testing —
      // operator found the cold baseline read as "rude" on real calls).
      // Flipping these three on adds light personality + occasional empathy
      // markers without making the agent verbose; the voice config below
      // does the heavy lifting on perceived warmth.
      default_personality: true,
      scope_boundaries: true,
      natural_filler_words: true,
      nato_phonetic_alphabet: false,
      high_empathy: true,
      ai_disclosure: true,
      smart_matching: true,
    },
    voice_id: "11labs-Billy",
    voice_model: "eleven_turbo_v2",
    fallback_voice_ids: [],
    // Higher temperature = more expressive intonation. 0.98 was tuned
    // against the post-warmth handbook flags above; lowering this back
    // toward 0.5 with high_empathy on tends to sound monotone and clinical.
    voice_temperature: 0.98,
    // Sub-1 reads "deliberate"; the prior 1.02 default felt rushed in
    // back-to-back data collection nodes.
    voice_speed: 0.98,
    enable_dynamic_voice_speed: false,
    volume: 1.92,
    enable_backchannel: false,
    backchannel_frequency: 0.2,
    backchannel_words: ["got it"],
    reminder_trigger_ms: 10000,
    reminder_max_count: 3,
    max_call_duration_ms: 655000,
    interruption_sensitivity: 0.84,
    ambient_sound: "coffee-shop",
    ambient_sound_volume: 0.86,
    responsiveness: 1,
    // Effectively gated by handbook_config.speech_normalization — Retell
    // coerces this to true when speech_normalization is on, which it is by
    // default. Set to true to match what actually lands on the agent.
    normalize_for_speech: true,
    begin_message_delay_ms: 2000,
    voicemail_option: { action: { type: "hangup" } },
    stt_mode: "custom",
    custom_stt_config: {
      provider: "deepgram",
      // Longer endpointing = Deepgram waits more before deciding the caller
      // stopped speaking. Pairs with the slower voice_speed: fewer mid-
      // thought interruptions when callers pause to think.
      endpointing_ms: 1540,
    },
    // Allows touch-tone input (e.g. caller pressing digits to confirm a
    // phone number). Low-risk affordance; can be re-disabled per agent.
    allow_user_dtmf: true,
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
        description: "Evaluate user's sentiment, mood and satisfaction level.",
      },
    ],
    conversationFlow,
  };
}
