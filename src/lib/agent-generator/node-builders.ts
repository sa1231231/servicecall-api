import type { DataPoint, FinetuneExample, SendSmsAction } from "./data-point-registry.js";
import {
  NOT_MENTIONED,
  PHONE_COLLECTED_FLAG,
  PATH_TAKEN_VAR,
  isSendSmsAction,
} from "./data-point-registry.js";
import { renderTemplate } from "../build-notification.js";

// Identifier for the MCP server entry the generator drops into
// `conversationFlow.mcps[]` when any path contains an SMS action. Used as
// the entry's `id` and `name`, and as the `mcp_id` on every McpNode —
// Retell binds a node to its server by matching mcp_id to the entry id.
export const MCP_SERVER_NAME = "servicecall-mcp";

// Tool name on the MCP server. McpNodes set this on `mcp_tool_name`.
export const SEND_SMS_TOOL_NAME = "send_sms";

// Backwards-compat alias for code outside node-builders that imported the
// pre-MCP constant. The parser still uses it to detect SMS nodes.
export const SEND_SMS_TOOL_ID = SEND_SMS_TOOL_NAME;

// Public URL of the MCP server (mounted at /mcp in src/index.ts). Kept
// alongside the post-hook URL (line ~1222) so they share the same source of
// truth for the public host.
export const MCP_SERVER_URL =
  "https://servicecall-api-production.up.railway.app/mcp";

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
  { type: "positive", transcript: [{ content: "How much is a service call?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What does it cost?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "How much do you charge for an estimate?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What's your hourly rate?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Is there a fee just to come out?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Can you give me a ballpark price?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Before I commit — what am I looking at price-wise?", role: "user" }, { content: "", role: "agent" }] },
  // Hours / availability
  { type: "positive", transcript: [{ content: "Are you open on weekends?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What time do you close?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you do after-hours service?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Are you open today?", role: "user" }, { content: "", role: "agent" }] },
  // Services offered / coverage
  { type: "positive", transcript: [{ content: "Do you work on Carrier units?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you do installations or just repairs?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you handle commercial buildings?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you service my area?", role: "user" }, { content: "", role: "agent" }] },
  // Warranty / credentials / trust
  { type: "positive", transcript: [{ content: "Are you licensed and insured?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you offer any warranty on repairs?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "How long have you been in business?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Is my unit still under warranty?", role: "user" }, { content: "", role: "agent" }] },
  // Logistics / process
  { type: "positive", transcript: [{ content: "How does this work?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What should I expect when the technician arrives?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do I need to be home for the appointment?", role: "user" }, { content: "", role: "agent" }] },
];

// Caller responses to "Is there anything else I can help you with?" that
// should route to the Admin/FAQ global node instead of advancing to Closing
// Remarks. The shape is distinctive (often prefixed with "actually yeah",
// "one more thing", "now that you mention it") so we train it explicitly on
// the Close Question node rather than relying on the global FAQ classifier
// alone. Attached as finetune_transition_examples with destination set to
// the Admin/FAQ node id at build time.
export const CLOSE_QUESTION_FAQ_FINETUNE_EXAMPLES: FinetuneExample[] = [
  { type: "positive", transcript: [{ content: "Actually yeah — how much do you guys charge for a service call?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Yes, one more thing — are you licensed and insured?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Hmm, actually — do you work on weekends?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Wait, before I forget — what's your service area?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Oh yeah, one quick question — do you offer any warranty?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Actually I do have one — how long have you been in business?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Hold on — do I need to be home when the technician comes out?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Now that you mention it — what time will they actually show up?", role: "user" }, { content: "", role: "agent" }] },
];

// Caller utterances that arrive at the Intro node as an inbound *question*
// rather than a service request. The Admin/FAQ global node intercepts them
// via its `condition` + `positive_finetune_examples`, but the Intro node's
// "do NOT leave this node if the caller is only asking questions" prompt
// can otherwise pull the model into a path Transition before the global
// classifier fires. Training these explicitly on the Intro node biases the
// model toward the FAQ jump at the very first turn of the call.
export const INTRO_FAQ_FINETUNE_EXAMPLES: FinetuneExample[] = [
  { type: "positive", transcript: [{ content: "Hi — what are your hours?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "How much do you guys charge for a service call?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you do residential work or just commercial?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Are you guys open today?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Quick question — are you licensed and insured?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you service my area?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What kind of payment do you accept?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Do you offer free estimates?", role: "user" }, { content: "", role: "agent" }] },
];

// In-node response training for the Admin/FAQ node. Emitted on the
// FAQ node's `finetune_conversation_examples` field — trains the
// agent's reply style (short, declarative, no follow-up questions),
// not the routing-jump signal. Style-focused so the answers stay
// generic across verticals; the actual content gets overridden at
// runtime by the FAQ knowledge base.
export const FAQ_CONVERSATION_FINETUNE_EXAMPLES: FinetuneExample[] = [
  { type: "positive", transcript: [
    { content: "What are your hours?", role: "user" },
    { content: "We're open Monday through Friday, 8 to 5.", role: "agent" },
  ]},
  { type: "positive", transcript: [
    { content: "How much do you charge?", role: "user" },
    { content: "Pricing is provided during the consultation.", role: "agent" },
  ]},
  { type: "positive", transcript: [
    { content: "Do you service my area?", role: "user" },
    { content: "Yes, we cover the surrounding area.", role: "agent" },
  ]},
  { type: "positive", transcript: [
    { content: "Are you licensed and insured?", role: "user" },
    { content: "Yes, we are.", role: "agent" },
  ]},
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
  // Mark Close Said extract sits between Close and Close Question. It
  // stamps `_close_was_said = "true"` so a second pass through the
  // Variables Router (after a FAQ side-trip) can skip Close and go
  // straight to Close Question via the router shortcut edge. Only
  // allocated for callback paths; transfer paths have no Close.
  markCloseSaidId?: string;
}

export type HumanRequestMode = "live_transfer" | "callback";

interface Ids {
  introId: string;
  endId: string;
  faqId: string;
  /** Deterministic resume router: sits between FAQ's "answered" edge and
   *  the rest of the flow. Checks `_path_taken` and routes straight to
   *  the matching path's Variables Router on a mid-call FAQ return.
   *  Falls through to Intro when `_path_taken` doesn't exist yet (FAQ
   *  asked before the caller stated their intent). See buildPathRouterNode. */
  pathRouterId: string;
  humanReqId: string;
  transferCallId: string;
  transferFailedId: string;
  irrelevantGuardrailId: string;
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
  /** Per-path Close node position (multi-path only). Single-path uses
   *  the shared Positions.close. */
  close?: Position;
  /** Per-path Mark Close Said extract position. Sits between Close and
   *  Close Question, same Y as Close, one column to the right. */
  markCloseSaid?: Position;
}

interface Positions {
  intro: Position;
  end: Position;
  faq: Position;
  pathRouter: Position;
  humanReq: Position;
  irrelevantGuardrail: Position;
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
  /** Positive utterances that should route the caller to the Human Request
   *  global node ("can I talk to a person?", "transfer me to a human", etc.).
   *  Merged into the global node's positive_finetune_examples on top of the
   *  hardcoded baseline. Only the `transcript` field is used; `type` /
   *  `destination` are ignored because the global node has a fixed target. */
  humanRequestFinetuneExamples?: FinetuneExample[];
  humanRequestMode?: HumanRequestMode;
  // Optional override for the Intro node's instruction text. When unset (or
  // blank), the generator uses DEFAULT_INTRO_PROMPT. {{business_name}} is
  // substituted at build time, so overrides stay reusable across drafts.
  introPrompt?: string;
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
  // Workspace-default fine-tune example overrides. When set, these replace
  // the hardcoded FAQ_GLOBAL_POSITIVE_EXAMPLES / CLOSE_QUESTION_FAQ_FINETUNE_EXAMPLES /
  // INTRO_FAQ_FINETUNE_EXAMPLES arrays in the generated nodes. Loaded from
  // GlobalSettings by the create-agent path so operators can edit defaults
  // in the Categories tab.
  faqGlobalFinetuneExamples?: FinetuneExample[];
  closeQuestionFinetuneExamples?: FinetuneExample[];
  // Examples of caller utterances that arrive at the Intro node as a
  // question (rather than a service request) so the global Admin/FAQ
  // jump fires on the first turn instead of getting captured by a
  // path-transition edge.
  introFaqFinetuneExamples?: FinetuneExample[];
  // Workspace-default positive FT examples for the Irrelevant Guardrail
  // global node. Merged on top of IRRELEVANT_GUARDRAIL_POSITIVE_EXAMPLES
  // at generation time (additive — baseline always ships).
  irrelevantGuardrailFinetuneExamples?: FinetuneExample[];
  // Workspace-default in-node response examples for the Admin/FAQ
  // node's `finetune_conversation_examples` field. Trains the agent's
  // reply style (short, declarative, no follow-ups). Merged on top of
  // FAQ_CONVERSATION_FINETUNE_EXAMPLES additively.
  faqConversationFinetuneExamples?: FinetuneExample[];
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

export function resolveFinetuneExamples(
  examples: FinetuneExample[] | undefined,
  defaultPositiveDestId: string,
  nodeMap: Record<string, string>,
  f: IdFactory,
) {
  return (examples || []).map((ex) => {
    const out: Record<string, unknown> = {
      transcript: ex.transcript,
      // Always mint a fresh, random-suffixed id — never reuse ex.id. The
      // same source example (e.g. one finetune example on a workspace
      // data-point-default) is emitted onto every path that uses the data
      // point; reusing its id made Retell reject the whole flow with
      // "Duplicate example id". The random suffix guarantees uniqueness
      // even across the separate per-path id factories the regenerator
      // uses — a bare counter alone could still collide between paths.
      id: `fe-${f.nextTs()}-${randomSuffix(9)}`,
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
      // Mark Close Said extract: one per callback path. Single-path
      // agents also get one (stored here on paths[0]); transfer paths
      // don't (no Close to follow).
      ...(!isTransfer ? { markCloseSaidId: f.nodeId() } : {}),
    };
  });

  return {
    introId: f.nodeId(),
    endId: f.nodeId(),
    faqId: f.nodeId(),
    pathRouterId: f.nodeId(),
    humanReqId: f.nodeId(),
    transferCallId: f.nodeId(),
    transferFailedId: f.nodeId(),
    irrelevantGuardrailId: f.nodeId(),
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
//
// Canvas geometry derived from a manually-arranged HVAC agent the operator
// confirmed read well in the Retell console. The shape:
//
//   • Globals on the LEFT (negative X) — Admin/FAQ, Human Request,
//     guardrails, Polite Hangup. So the operator's eye starts at the
//     conversation root and "global handlers" don't crowd the path columns.
//   • Intro just inside the right side, top of canvas.
//   • Each routing path is a horizontal Transition → Extract → Router row
//     followed by a vertical Collect/Confirm staircase. Same shape per
//     path so multi-path agents read like rhythm — eye drops down to the
//     next path and the layout repeats.
//   • Closing chain horizontal at the bottom, below all paths. Per-path
//     Close nodes stack vertically into a single Close Question →
//     Closing Remarks → Closing Statement → End row.
//
// Tweaking: keep changes here, not in the per-node builders. node-regenerator
// preserves existing display_positions on edit so historical agents won't be
// re-laid out unless the operator deletes + recreates.

// Intro (path-entry node).
const INTRO_POS: Position = { x: 558, y: -234 };

// Per-path header row (Transition + Extract + Router).
const HEADER_Y_REL = -138;
const TRANSITION_X = 1086;
const EXTRACT_X = 1662;
const ROUTER_X = 2190;

// Per-path Collect/Confirm chain. Each DP is one horizontal pair stacked
// DP_Y_STEP below the previous one. DP_Y_FIRST_REL is the first pair's Y
// relative to its path's yBase.
const DP_COLLECT_X = 2982;
const DP_CONFIRM_X = 3702;
const DP_Y_FIRST_REL = -42;
const DP_Y_STEP = 500;

// SMS actions sit in the same column as Collect/Confirm but below the last
// DP, so a path with both DPs and SMS reads top-to-bottom in source order.
const SMS_FUNC_X = DP_COLLECT_X;
const SMS_MARK_X = DP_CONFIRM_X;

// Transfer-mode replacement for the closing chain (per-path Pre-Transfer +
// Transfer Call, both below the last DP of that path).
const PRE_TRANSFER_X = DP_COLLECT_X;
const TRANSFER_CALL_X = DP_CONFIRM_X;

// Vertical gap between consecutive paths' baselines. Sized for ~5 DPs +
// SMS room + headroom so paths don't visually bleed into each other.
const PATH_Y_OFFSET = 3600;

// Closing chain X columns (horizontal row below all paths).
const CLOSE_X = 2742;
const CLOSE_QUESTION_X = 3294;
const CLOSING_REMARKS_X = 3846;
const CLOSING_STATEMENT_X = 4398;
const END_X = 4950;
const CLOSE_STACK_Y_STEP = 360; // vertical gap between per-path Close nodes
const CLOSE_HEADROOM = 500;      // gap from the deepest path's last node to the first Close

// Globals on the left.
const FAQ_POS: Position = { x: -498, y: -642 };
// Path Router sits between the FAQ globals column and the Intro path
// entry, just below Admin/FAQ. Visually communicates that it's part of
// the FAQ resume chain (not a "real" branch in the call flow).
const PATH_ROUTER_POS: Position = { x: 18, y: -642 };
const HUMAN_REQ_POS: Position = { x: -1242, y: 222 };
const IRRELEVANT_GUARDRAIL_POS: Position = { x: -1242, y: 942 };
const POLITE_HANGUP_POS: Position = { x: -690, y: 870 };
const GUARDRAIL_END_POS: Position = { x: -570, y: 1734 };

export function layoutPositions(
  pathSequences: Array<Array<DataPoint | SendSmsAction>>,
  pathEndModes?: Array<"callback" | "transfer">,
): Positions {
  // Compute the deepest Y any path's last DP / SMS reaches so the closing
  // chain can sit below all of them with consistent headroom.
  let deepestPathEndY = 0;

  const paths: PathPositions[] = pathSequences.map((seq, pathIdx) => {
    const yBase = pathIdx * PATH_Y_OFFSET;
    const isTransfer = pathEndModes?.[pathIdx] === "transfer";

    const dpPositions: Array<{ conv: Position; confirm: Position }> = [];
    const smsPositions: SmsActionPositions[] = [];
    seq.forEach((item) => {
      if (isSendSmsAction(item)) {
        // SMS lands at the next "row" below the last DP/SMS in this path,
        // using the same DP_Y_STEP cadence so the staircase stays uniform.
        const rowIdx = dpPositions.length + smsPositions.length;
        const rowY = yBase + DP_Y_FIRST_REL + rowIdx * DP_Y_STEP;
        smsPositions.push({
          func: { x: SMS_FUNC_X, y: rowY },
          markSent: { x: SMS_MARK_X, y: rowY },
        });
      } else {
        const rowIdx = dpPositions.length + smsPositions.length;
        const rowY = yBase + DP_Y_FIRST_REL + rowIdx * DP_Y_STEP;
        dpPositions.push({
          conv: { x: DP_COLLECT_X, y: rowY },
          confirm: { x: DP_CONFIRM_X, y: rowY },
        });
      }
    });

    const lastRowY = yBase + DP_Y_FIRST_REL +
      Math.max(0, dpPositions.length + smsPositions.length - 1) * DP_Y_STEP;
    if (lastRowY > deepestPathEndY) deepestPathEndY = lastRowY;

    const pathPos: PathPositions = {
      transition: { x: TRANSITION_X, y: yBase + HEADER_Y_REL },
      frontExtract: { x: EXTRACT_X, y: yBase + HEADER_Y_REL },
      router: { x: ROUTER_X, y: yBase + HEADER_Y_REL },
      chain: dpPositions,
      smsActions: smsPositions,
    };

    if (isTransfer) {
      // Transfer paths replace the closing chain with Pre-Transfer →
      // Transfer Call, dropped directly below the path's last DP row.
      const nextRowY = lastRowY + DP_Y_STEP;
      pathPos.preTransfer = { x: PRE_TRANSFER_X, y: nextRowY };
      pathPos.transferCall = { x: TRANSFER_CALL_X, y: nextRowY };
    }

    return pathPos;
  });

  // Closing chain Y: sit below the deepest path, then stack per-path Close
  // nodes vertically. The shared Close Question / Closing Remarks /
  // Closing Statement / End row sits at the vertical midpoint of the
  // Close stack so the layout reads as a centered convergence.
  const closeY0 = deepestPathEndY + CLOSE_HEADROOM;
  const closeYMid = closeY0 + ((pathSequences.length - 1) * CLOSE_STACK_Y_STEP) / 2;

  // Stamp per-path close + mark-close-said positions. Mark Close Said
  // sits between each Close and the shared Close Question — same Y as
  // its Close, one column to the right so the chain reads left → right
  // along the bottom row.
  paths.forEach((p, pathIdx) => {
    if (pathEndModes?.[pathIdx] === "transfer") return;
    const closeY = closeY0 + pathIdx * CLOSE_STACK_Y_STEP;
    p.close = { x: CLOSE_X, y: closeY };
    p.markCloseSaid = { x: CLOSE_X + 552, y: closeY };
  });

  return {
    intro: INTRO_POS,
    // Post-closing End Call: reached via Closing Statement.skip_response_edge.
    // Sits at the right end of the bottom row, same Y as Close Question /
    // Closing Remarks / Closing Statement. Different from guardrailEnd
    // below, which is the Polite Hangup chain's terminal.
    end: { x: END_X, y: closeYMid },
    faq: FAQ_POS,
    pathRouter: PATH_ROUTER_POS,
    humanReq: HUMAN_REQ_POS,
    irrelevantGuardrail: IRRELEVANT_GUARDRAIL_POS,
    politeHangup: POLITE_HANGUP_POS,
    guardrailEnd: GUARDRAIL_END_POS,
    // Single-path shared Close. Multi-path uses PathPositions.close per
    // path; the single-path emitter still reads this top-level position.
    close: { x: CLOSE_X, y: closeYMid },
    closeQuestion: { x: CLOSE_QUESTION_X, y: closeYMid },
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

/** Default instruction text for a path's Transition node — used when the
 *  path config supplies no transitionPrompt override. */
export const DEFAULT_TRANSITION_PROMPT = `Empathetically acknowledge the caller's situation, then say something like

"let me grab the information"

Do not ask any questions here.`;

export function buildTransitionNode(
  pathIds: PathIds,
  pathPos: PathPositions,
  f: IdFactory,
  pathName?: string,
  // Optional override for the skip_response_edge destination. Used when the
  // path has no data points — the caller passes the terminal node id (close
  // or pre-transfer) so the transition skips straight there.
  targetId?: string,
  // Optional override for the node's instruction text. Empty/undefined →
  // DEFAULT_TRANSITION_PROMPT. Lets the create form / drafts tune the prompt.
  transitionPrompt?: string,
  // Business name for {{business_name}} substitution in the prompt text.
  businessName?: string,
) {
  return {
    instruction: {
      type: "prompt",
      text: renderTemplate(transitionPrompt?.trim() || DEFAULT_TRANSITION_PROMPT, {
        business_name: businessName ?? "",
      }),
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

/** Default instruction text for the Intro node — used when AgentConfig
 *  supplies no introPrompt override. {{business_name}} is substituted at
 *  build time (see renderTemplate call in buildIntroNode). */
export const DEFAULT_INTRO_PROMPT = `Determine the reason for the caller's call.

Welcome the caller: "Thank you for calling {{business_name}}, this is Anthony. How may I help you?"

If the caller greets you, reciprocate the sentiment and then ask how you can help them.

Do not assume their name until they tell you explicitly.

Do NOT leave this node if the caller is only asking questions. Let the Admin/FAQ global node handle those and return here.`;

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
      // {{business_name}} + renderTemplate keeps the intro on the same
      // substitution convention as Close / Pre-Transfer / Live-Transfer
      // Recovery prompts (and lets replaceBusinessName scrub it on rename).
      // config.introPrompt, when set, overrides DEFAULT_INTRO_PROMPT — it's
      // rendered the same way so an override may still use {{business_name}}.
      text: renderTemplate(config.introPrompt?.trim() || DEFAULT_INTRO_PROMPT, {
        business_name: config.businessName,
      }),
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
      // Inbound-question examples: caller's first turn is a question, not
      // a service request. destination_node_id targets the Admin/FAQ
      // global node so the model jumps to FAQ instead of getting captured
      // by a path-transition edge. No explicit edge from Intro to FAQ —
      // single source of truth in the Retell UI (same pattern as Close
      // Question after the duplicate-destination fix).
      ...mergeAdditiveFinetunes(
        INTRO_FAQ_FINETUNE_EXAMPLES,
        config.introFaqFinetuneExamples,
      ).map((ex) => ({
        transcript: ex.transcript,
        id: ex.id || `fe-${f.nextTs()}`,
        destination_node_id: ids.faqId,
      })),
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
  _isMultiPath?: boolean,
  positiveExamples?: FinetuneExample[],
  conversationExamples?: FinetuneExample[],
) {
  // Forward through the Path Router on the "answered the caller's
  // question" exit — that node checks _path_taken and skips back to
  // the matching path's Variables Router when the caller jumped into
  // FAQ mid-call. Falls through to Intro when no path has been entered
  // yet. This is the fallback when Retell's `go_back_conditions`
  // doesn't fire reliably; when it does, the caller returns to their
  // previous node directly and never traverses this edge.
  const forwardDestination = ids.pathRouterId;

  // Additive layering: baseline always ships, workspace override extends
  // it (dedup by user-utterance). Operator can add to the baseline but
  // not remove built-in entries — keeps the global classifier from being
  // accidentally untrained on a critical phrasing.
  const examples = mergeAdditiveFinetunes(FAQ_GLOBAL_POSITIVE_EXAMPLES, positiveExamples);
  // In-node response training (style — short, declarative, no
  // follow-ups). Same additive merge against the hardcoded
  // FAQ_CONVERSATION_FINETUNE_EXAMPLES baseline. Strip the `type`
  // field on emit; each entry needs an `id` (Retell rejects the flow
  // otherwise — same schema requirement as finetune_transition_examples).
  const conversationFts = mergeAdditiveFinetunes(
    FAQ_CONVERSATION_FINETUNE_EXAMPLES,
    conversationExamples,
  ).map((ex) => ({
    transcript: ex.transcript,
    id: ex.id || `fe-${f.nextTs()}`,
  }));

  return {
    instruction: {
      type: "prompt",
      // Trailing "no follow-ups" directive stops the model from
      // tacking on "is there anything else?" or expanding into
      // adjacent topics inside the FAQ node — Close Question already
      // handles the follow-up gate downstream, and the skip-response
      // edge below auto-routes back to the path as soon as the answer
      // finishes.
      text: `Your goal is to answer administrative and general questions briefly and accurately.

${faqKnowledgeBase}

Do not ask any questions or elaborate, just answer the question.`,
    },
    name: "Admin/FAQ",
    finetune_conversation_examples: conversationFts,
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
      positive_finetune_examples: examples.map((ex) => ({
        transcript: ex.transcript,
      })),
      negative_finetune_examples: [],
    },
    id: ids.faqId,
    type: "conversation",
    display_position: pos.faq,
    // Auto-route to the Path Router once Retell stops speaking on this
    // node — no waiting for the caller's next turn. The Path Router
    // resumes the matching path's Variables Router via _path_taken, or
    // falls through to Intro when no path has been entered yet.
    // go_back_conditions still fires when the model spontaneously
    // decides it's done answering; this edge is the structural
    // fallback that guarantees deterministic routing.
    skip_response_edge: {
      destination_node_id: ids.pathRouterId,
      id: `skip-response-edge-${f.nextTs()}-${randomSuffix(9)}`,
      transition_condition: { type: "prompt", prompt: "Skip response" },
    },
  };
}

/**
 * Deterministic resume router for mid-call FAQ returns.
 *
 * Sits between the Admin/FAQ node's "answered the caller's question"
 * edge and the rest of the flow. Evaluates `_path_taken` (the hidden
 * variable each path's front Extract stamps on entry) and routes
 * straight to the matching path's Variables Router — skipping Intro
 * re-classification and the Transition's "let me grab the information"
 * reacknowledgement. When `_path_taken` doesn't exist (FAQ asked before
 * any path entry), the else_edge falls through to Intro and the call
 * unfolds normally.
 *
 * This is the safety net for Retell's `go_back_conditions`. When go-back
 * fires, the caller returns to their previous node directly and never
 * touches this router. When go-back is finicky and the FAQ's explicit
 * "answered" edge fires instead, the Path Router resumes the path
 * deterministically instead of re-classifying.
 */
export function buildPathRouterNode(
  ids: Ids,
  pos: Positions,
  f: IdFactory,
  pathConfigs?: IntroPathConfig[],
) {
  // Single-path agents still get a Path Router. The Default path's
  // front Extract stamps `_path_taken = "Default"`, so a mid-call FAQ
  // return matches and skips Intro + Transition reacknowledgement.
  const paths = pathConfigs && pathConfigs.length > 0
    ? pathConfigs.map((p) => p.name)
    : ["Default"];

  return {
    name: "Path Router",
    type: "branch",
    id: ids.pathRouterId,
    edges: paths.map((pathName, i) => ({
      destination_node_id: ids.paths[i].routerId,
      id: f.edgeId(),
      transition_condition: {
        type: "equation",
        equations: [
          { left: "{{_path_taken}}", operator: "==", right: pathName },
        ],
        operator: "&&",
      },
    })),
    else_edge: {
      destination_node_id: ids.introId,
      id: `${ids.pathRouterId}-else-edge`,
      transition_condition: { type: "prompt", prompt: "Else" },
    },
    display_position: pos.pathRouter,
  };
}

// Hardcoded baseline for the Irrelevant Guardrail global node's
// positive_finetune_examples. Trains the classifier to jump to the
// "we can only do allowed/relevant tasks" prompt when the caller goes
// off-topic. Shipped in every agent; operator's workspace override
// layers on top via mergeAdditiveFinetunes.
const IRRELEVANT_GUARDRAIL_POSITIVE_EXAMPLES: FinetuneExample[] = [
  { type: "positive", transcript: [{ content: "Tell me a joke.", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What's the weather like today?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Who's going to win the game tonight?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What do you think about the election?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Can you write me a poem?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "What's your favorite color?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Hey, do you have a girlfriend?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Can we just chat for a bit?", role: "user" }, { content: "", role: "agent" }] },
];

// Hardcoded baseline used by buildHumanRequestNode. Stays in the published
// flow even when the operator provides their own examples — represents the
// minimum classifier signal the global node needs to fire.
const HUMAN_REQUEST_BASELINE_EXAMPLES: FinetuneExample[] = [
  { type: "positive", transcript: [{ content: "can I talk to the supervisor?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Can I speak to a person?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Transfer me to a human.", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Is there a live agent I can talk to?", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "I want to talk to someone real.", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Get me a manager.", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "I need to talk to a real person, not a bot.", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Just put me through to a representative.", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "Connect me to your team.", role: "user" }, { content: "", role: "agent" }] },
  { type: "positive", transcript: [{ content: "I want to speak to an actual person.", role: "user" }, { content: "", role: "agent" }] },
];

/**
 * The hardcoded fine-tune baselines, keyed by the workspace-settings field
 * they extend (`<key>_finetune_examples`). Surfaced read-only in the
 * dashboard Categories tab so operators can see exactly what ships in every
 * agent before adding their own examples. All six are layered additively via
 * mergeAdditiveFinetunes at generation time — a workspace setting extends the
 * matching baseline here, it never replaces it.
 */
export const FT_BUILTIN_BASELINES: Record<string, FinetuneExample[]> = {
  faq_global: FAQ_GLOBAL_POSITIVE_EXAMPLES,
  close_question: CLOSE_QUESTION_FAQ_FINETUNE_EXAMPLES,
  intro_faq: INTRO_FAQ_FINETUNE_EXAMPLES,
  irrelevant_guardrail: IRRELEVANT_GUARDRAIL_POSITIVE_EXAMPLES,
  faq_conversation: FAQ_CONVERSATION_FINETUNE_EXAMPLES,
  human_request: HUMAN_REQUEST_BASELINE_EXAMPLES,
};

/**
 * Merge a hardcoded baseline + operator-supplied workspace examples into the
 * shape Retell stores on a node's positive_finetune_examples (or any other
 * FinetuneExample array). Dedups by the first user-utterance text so
 * re-publishes don't accumulate, and so an operator who copy-pastes a
 * baseline phrasing into their workspace setting doesn't produce duplicates.
 *
 * Layering is ALWAYS additive: the baseline ships in every agent, the
 * workspace override extends it. An operator that wants to suppress a
 * baseline phrasing has to do it manually in the Retell console (out of
 * scope here — the workspace UI only adds).
 *
 * Used by Human Request, Irrelevant Guardrail, Admin/FAQ global, Close
 * Question, and Intro→FAQ classifiers.
 */
export function mergeAdditiveFinetunes(
  baseline: FinetuneExample[],
  operatorExamples: FinetuneExample[] | undefined,
): FinetuneExample[] {
  const merged: FinetuneExample[] = [...baseline];
  const seen = new Set<string>(
    merged.map((ex) =>
      ex.transcript.find((t) => t.role === "user")?.content?.trim() ?? "",
    ),
  );
  for (const ex of operatorExamples ?? []) {
    const utter = ex.transcript.find((t) => t.role === "user")?.content?.trim() ?? "";
    if (!utter || seen.has(utter)) continue;
    seen.add(utter);
    merged.push(ex);
  }
  return merged;
}

/**
 * Back-compat wrapper around mergeAdditiveFinetunes for the Human Request
 * baseline. Returns the shape Retell stores on global_node_setting
 * (transcript-only objects, no type field).
 *
 * Exported so the dashboard save-and-publish handler can refresh existing
 * agents' Human Request node from workspace settings on every publish.
 */
export function mergeHumanRequestExamples(operatorExamples: FinetuneExample[] | undefined) {
  return mergeAdditiveFinetunes(HUMAN_REQUEST_BASELINE_EXAMPLES, operatorExamples)
    .map((ex) => ({ transcript: ex.transcript }));
}

export function buildHumanRequestNode(
  ids: Ids,
  pos: Positions,
  f: IdFactory,
  mode: HumanRequestMode = "callback",
  operatorExamples?: FinetuneExample[],
) {
  const positiveExamples = mergeHumanRequestExamples(operatorExamples);

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
        positive_finetune_examples: positiveExamples,
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
      negative_finetune_examples: [],
      positive_finetune_examples: positiveExamples,
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
  operatorExamples?: FinetuneExample[],
) {
  // Strip the `type` field — Retell stores positives without it on
  // global_node_setting.positive_finetune_examples.
  const positiveExamples = mergeAdditiveFinetunes(
    IRRELEVANT_GUARDRAIL_POSITIVE_EXAMPLES,
    operatorExamples,
  ).map((ex) => ({ transcript: ex.transcript }));
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
      positive_finetune_examples: positiveExamples,
    },
    id: ids.irrelevantGuardrailId,
    type: "conversation",
    display_position: pos.irrelevantGuardrail,
  };
}

// Previously: a global "Emergency Gaurd Rail" node that intercepted gas /
// carbon-monoxide / fire emergencies and routed the caller to Polite
// Hangup with a 9-1-1 prompt. Retell ships its own built-in emergency
// guardrail (operator confirmed), so the bespoke node was redundant —
// removed in May 2026 to keep the left-side global column tidy.

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

// ── Send SMS: MCP server entry + node pair ───────────────────────────────────

/**
 * Returns the MCP server entry the generator drops into
 * `conversationFlow.mcps[]`. Retell calls this URL with JSON-RPC for every
 * McpNode invocation; the bearer header authenticates against our `/mcp`
 * endpoint (see src/routes/mcp.ts).
 *
 * Retell requires a non-empty `id` on every mcps[] entry and pairs each
 * McpNode to its server by matching the node's `mcp_id` to the entry `id`
 * (omitting it fails flow creation with "MCP id cannot be empty or null").
 * We use MCP_SERVER_NAME for both `id` and `name`, and as every McpNode's
 * `mcp_id`, so the binding is one stable constant.
 */
export function buildMcpServerEntry(apiKey: string) {
  return {
    id: MCP_SERVER_NAME,
    name: MCP_SERVER_NAME,
    url: MCP_SERVER_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout_ms: 10000,
  };
}

/**
 * Builds the two-node pair for a single SMS action:
 *   1. McpNode — invokes the send_sms tool on our MCP server with the
 *      configured template (Retell injects {{var}} substitution before the
 *      request is sent, so caller-collected variables interpolate).
 *   2. Mark Sent extract — flips the per-action sentinel variable to "true"
 *      so the Variables Router routes past this step on the next visit.
 *
 * Both edges out of the McpNode (success + failure) route through Mark Sent
 * so a Twilio failure doesn't trap the call in a router→mcp→router→mcp loop —
 * the action fires exactly once. Twilio errors are logged in outbound_messages.
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
  // Retell substitutes {{var}} in the instruction text before invoking the
  // MCP tool. We serialize the literal args as JSON so the runtime sees a
  // single deterministic call shape with no LLM judgment required.
  const argsObj: Record<string, unknown> = { message: action.template };
  if (action.to) argsObj.to = action.to;
  const argsJson = JSON.stringify(argsObj);

  const funcNode = {
    id: sIds.funcId,
    type: "mcp",
    mcp_id: MCP_SERVER_NAME,
    mcp_tool_name: SEND_SMS_TOOL_NAME,
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
    // Retell requires the literal "Else" on else_edge transition prompts.
    // The destination still goes through Mark Sent so the sentinel flips
    // either way and the action fires exactly once.
    else_edge: {
      id: f.edgeId(),
      transition_condition: { type: "prompt", prompt: "Else" },
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
  closeQuestionId: string,
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

  // Close-already-said shortcut. Last edge before else_edge so it only
  // fires when no missing-var edge matches (i.e. all data already
  // collected) AND the caller has previously heard the Close node's
  // "thank you for the info" line. Set by the Mark Close Said extract
  // downstream of Close. Skips Close on the second pass so the caller
  // doesn't hear the thank-you a second time after a FAQ side-trip.
  routerEdges.push({
    destination_node_id: closeQuestionId,
    id: f.edgeId(),
    transition_condition: {
      type: "equation",
      equations: [
        { left: "{{_close_was_said}}", operator: "==", right: "true" },
      ],
      operator: "&&",
    },
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
    //
    // Order: non-orphans first, then orphans. parseDataPointFromNodes
    // identifies the just-collected primary variable as `confirmVars[0]`,
    // so we MUST keep the tapered non-orphan at index 0 — otherwise an
    // orphan placed earlier in source order would shadow it and the
    // parser would mis-attribute this Collect/Confirm pair to the orphan.
    // The dashboard's Node Editor uses dataChain/steps order (not Confirm
    // variables) to render the routing pad, so the orphan's position
    // there is preserved by the parser, not by this list.
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
  markCloseSaidId: string,
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
      // Close → Mark Close Said → Close Question. The Mark Close Said
      // extract stamps `_close_was_said = "true"` so a second pass
      // through the Variables Router (after a FAQ side-trip) can skip
      // Close via the router shortcut edge.
      destination_node_id: markCloseSaidId,
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

/**
 * Mark Close Said extract — sits between a Close node and the shared
 * Close Question. Stamps `_close_was_said = "true"` so the Variables
 * Router's shortcut edge can skip Close on a second pass (e.g. after a
 * mid-call FAQ side-trip returning through the Path Router).
 *
 * One per callback path (transfer paths have no Close).
 */
export function buildMarkCloseSaidNode(
  ids: Ids,
  f: IdFactory,
  nodeId: string,
  displayPosition: Position,
  pathName?: string,
) {
  const name = pathName ? `Mark Close Said (${pathName})` : "Mark Close Said";
  return {
    name,
    type: "extract_dynamic_variables",
    id: nodeId,
    variables: [
      {
        name: "_close_was_said",
        type: "boolean",
        description: "Always set to true",
      },
    ],
    edges: [],
    finetune_transition_examples: [],
    else_edge: {
      destination_node_id: ids.closeQuestionId,
      id: `${nodeId}-else-edge`,
      transition_condition: { type: "prompt", prompt: "Else" },
    },
    display_position: displayPosition,
  };
}

// "Is there anything else I can help you with?" — sits between Close and
// Closing Remarks. Two explicit edges: "no more questions" advances to
// Closing Remarks; "has another question" routes to Admin/FAQ. The Admin/FAQ
// global node still intercepts questions globally (and its go_back_conditions
// returns the caller here once answered), but the explicit edge plus the
// CLOSE_QUESTION_FAQ_FINETUNE_EXAMPLES training set gives the model a
// stronger, context-specific signal for follow-up-question phrasing
// ("actually yeah…", "one more thing…") that's characteristic of this node.
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
    // Only one explicit edge — to Closing Remarks when the caller is done.
    // The Admin/FAQ global node catches follow-up questions via its
    // `condition` + go_back_conditions; emitting a second edge here
    // doubled the destination in Retell's console (once via edge, once
    // via global) which read as a bug.
    //
    // The finetune_transition_examples below still carry
    // destination_node_id = ids.faqId. With no explicit edge to FAQ,
    // those train the model on the contextual "actually yeah / one more
    // thing" phrasing specific to this node and trigger the global jump
    // — single source of truth in the Retell UI.
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
    finetune_transition_examples: mergeAdditiveFinetunes(
      CLOSE_QUESTION_FAQ_FINETUNE_EXAMPLES,
      agentConfig.closeQuestionFinetuneExamples,
    ).map((ex) => ({
      transcript: ex.transcript,
      id: ex.id || `fe-${f.nextTs()}`,
      destination_node_id: ids.faqId,
    })),
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
  // Closing Remarks / Statement / (post-closing) End share the same Y row
  // as Close Question — the chain reads left-to-right along the bottom of
  // the canvas: Close (per-path) → Close Question → Closing Remarks →
  // Closing Statement → End.
  const rowY = pos.closeQuestion.y;
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
      display_position: { x: CLOSING_REMARKS_X, y: rowY },
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
      display_position: { x: CLOSING_STATEMENT_X, y: rowY },
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
