// Maps a `proposed_change` from the analyzer into the `changes` body that
// the existing `save-and-publish` endpoint accepts. Pure function — no I/O.
//
// Two outputs per call:
//   1. `payload`  — the save-and-publish request body
//   2. `diff_preview` — structured before/after of THE specific component
//      this change targets, computed from the live snapshot. The dashboard
//      renders this as "Editing {component} on {node}: <before> → <after>".
//
// Append-not-replace policy: every kind that *could* destroy operator-
// authored content (FAQ, prompts, finetune arrays, transition conditions)
// reads the current value and produces a NEW value that incorporates it.
// The applier never replaces wholesale.

import type {
  ProposedChange,
  ProposedChangeKind,
  DiffPreview,
  ComponentKind,
} from "./call-findings.js";
import { parseConversationFlow } from "./node-parser.js";

// ── Snapshot the applier reads from ────────────────────────────────────────
//
// Derived from the agent's canonical JSON via `buildSnapshotFromCanonical`.
// The approve route handler builds the snapshot once, then calls the applier;
// the applier itself stays pure.

/** Matches the canonical shape used across the codebase (see
 *  agent-generator/data-point-registry.ts). The transcript is a structured
 *  array, not a string — Retell's finetune format. */
export interface FinetuneExample {
  id?: string;
  type?: "positive" | "negative";
  transcript: Array<{ content: string; role: "user" | "agent" }>;
  /** When the example routes the agent to a specific destination node, this
   *  is its id. We capture it on intro examples so the diff can label
   *  "(routes to FAQ)" vs. "(routes to {path})". */
  destination_node_id?: string;
}

export interface ApplierSnapshot {
  /** Agent-level. */
  globalPrompt?: string;
  faqKnowledgeBase?: string;
  faqNodeId?: string;
  /** Intro node — the greeting/router. */
  introNodeId?: string;
  introPrompt?: string;
  introFinetuneExamples: FinetuneExample[];
  /** Per-routing-path. */
  paths: Array<{
    name: string;
    transitionNodeId?: string;
    /** Intro→this-path edge transition_condition.prompt — the routing
     *  prompt the analyzer adjusts when the agent's path-selection logic
     *  is too rigid or too loose. */
    transitionPrompt?: string;
    closeNodeId?: string;
    closePrompt?: string;
    dataPoints: Array<{
      variableName: string;
      label: string;
      collectNodeId: string;
      conversationPrompt: string;
      finetuneExamples: FinetuneExample[];
    }>;
  }>;
}

// ── Result shape ────────────────────────────────────────────────────────────

export interface PublishPayload {
  changes: Record<string, unknown>;
}

export interface ApplyResult {
  ok: true;
  payload: PublishPayload;
  /** Plain-English description of what will be published. Used in audit log. */
  description: string;
  /** Computed before/after of the specific component being edited. */
  diff_preview: DiffPreview;
}

export interface ApplyError {
  ok: false;
  error: string;
  /** Set when the kind is advisory-only (no auto-apply path). The dashboard
   *  surfaces a "this is advisory — please make the edit by hand" badge. */
  advisoryOnly?: boolean;
}

export type ApplyResultOrError = ApplyResult | ApplyError;

// ── Public API ──────────────────────────────────────────────────────────────

export function buildPublishPayload(
  proposed: ProposedChange,
  snapshot: ApplierSnapshot,
): ApplyResultOrError {
  // Normalize legacy kind names so existing suggestions in Mongo still work.
  const kind = canonicalKind(proposed.kind);
  switch (kind) {
    case "edit_global_prompt":
      return applyEditGlobalPrompt(proposed, snapshot);
    case "add_faq_entry":
      return applyAddFaqEntry(proposed, snapshot);
    case "edit_intro_prompt":
      return applyEditIntroPrompt(proposed, snapshot);
    case "edit_intro_transition":
      return applyEditIntroTransition(proposed, snapshot);
    case "add_intro_finetune":
      return applyAddIntroFinetune(proposed, snapshot);
    case "edit_collect_prompt":
      return applyEditCollectPrompt(proposed, snapshot);
    case "add_collect_finetune":
      return applyAddCollectFinetune(proposed, snapshot);
    case "edit_close_prompt":
      return applyEditClosePrompt(proposed, snapshot);
    case "edit_router_branch":
      return {
        ok: false,
        advisoryOnly: true,
        error: "Router branch conditions require manual review — this suggestion is advisory.",
      };
    case "split_data_point":
      return {
        ok: false,
        advisoryOnly: true,
        error: "Splitting a data point is structural — this suggestion is advisory.",
      };
    case "add_finetune_example":
    case "edit_close_transition":
      // Legacy aliases — canonicalKind() should have already mapped these.
      // If we land here it means a new alias slipped in unmapped.
      return error(`Unmapped legacy kind: ${kind} (canonicalKind() needs an alias entry)`);
    default:
      return assertNever(kind);
  }
}

/** Map old kind names to the new precise ones. Anything not in the map
 *  passes through unchanged. */
function canonicalKind(kind: ProposedChangeKind): ProposedChangeKind {
  if (kind === "add_finetune_example") return "add_collect_finetune";
  if (kind === "edit_close_transition") return "edit_close_prompt";
  return kind;
}

// ── Per-kind handlers ───────────────────────────────────────────────────────

function applyEditGlobalPrompt(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const append = readString(proposed.payload.append);
  if (!append) return error("edit_global_prompt: payload.append must be a non-empty string");
  const current = snapshot.globalPrompt ?? "";
  if (current.includes(append.trim())) return error("Global prompt already contains this addition.");
  const merged = mergeAppend(current, append);
  return {
    ok: true,
    description: `Append to global prompt: ${truncate(append, 80)}`,
    payload: { changes: { globalPrompt: merged } },
    diff_preview: textDiff("global_prompt", "Global system prompt", "Global", current, merged),
  };
}

function applyAddFaqEntry(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const entry = readString(proposed.payload.entry);
  if (!entry) return error("add_faq_entry: payload.entry must be a non-empty string");
  const current = snapshot.faqKnowledgeBase ?? "";
  if (current.includes(entry.trim())) return error("FAQ already contains this entry.");
  const merged = mergeAppend(current, entry);
  return {
    ok: true,
    description: `Add FAQ entry: ${truncate(entry, 80)}`,
    payload: { changes: { faqKnowledgeBase: merged } },
    diff_preview: textDiff("faq_knowledge_base", "FAQ knowledge base", "FAQ node", current, merged),
  };
}

function applyEditIntroPrompt(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const append = readString(proposed.payload.append);
  if (!append) return error("edit_intro_prompt: payload.append must be a non-empty string");
  if (!snapshot.introNodeId) return error("Agent has no intro node — cannot apply.");
  const current = snapshot.introPrompt ?? "";
  if (current.includes(append.trim())) return error("Intro prompt already contains this addition.");
  const merged = mergeAppend(current, append);
  return {
    ok: true,
    description: `Append to intro prompt: ${truncate(append, 80)}`,
    payload: { changes: { introPrompt: merged } },
    diff_preview: textDiff(
      "conversation_prompt",
      "Intro — conversation prompt",
      "Intro",
      current,
      merged,
    ),
  };
}

function applyEditIntroTransition(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const append = readString(proposed.payload.append);
  if (!append) return error("edit_intro_transition: payload.append must be a non-empty string");
  const pathName = proposed.target_path_name;
  if (!pathName) return error("edit_intro_transition requires target_path_name");
  const path = snapshot.paths.find((p) => p.name === pathName);
  if (!path) return error(`Path "${pathName}" not found.`);
  const current = path.transitionPrompt ?? "";
  if (current.includes(append.trim())) return error("Transition condition already contains this addition.");
  const merged = mergeAppend(current, append);
  // save-and-publish accepts changes.transitionConditions: { [pathName]: text }
  return {
    ok: true,
    description: `Append to ${pathName} routing prompt: ${truncate(append, 80)}`,
    payload: { changes: { transitionConditions: { [pathName]: merged } } },
    diff_preview: textDiff(
      "transition_condition",
      `Intro → ${pathName} routing condition`,
      "Intro",
      current,
      merged,
    ),
  };
}

function applyAddIntroFinetune(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const userTurn = readString(proposed.payload.user);
  const agentTurn = readString(proposed.payload.agent);
  if (!userTurn || !agentTurn) {
    return error("add_intro_finetune: payload.user and payload.agent must both be non-empty strings");
  }
  const routesTo = readString(proposed.payload.routes_to) ?? "negative";

  const newTranscript = buildExampleTranscript(userTurn, agentTurn);

  if (snapshot.introFinetuneExamples.some((ex) => transcriptEquals(ex.transcript, newTranscript))) {
    return error("An equivalent intro finetune example already exists.");
  }

  if (routesTo === "negative") {
    const newEx: FinetuneExample = { transcript: newTranscript, type: "negative" };
    const negatives = snapshot.introFinetuneExamples.filter((e) => !e.destination_node_id);
    const next = [...negatives, newEx];
    return {
      ok: true,
      description: `Add intro finetune (negative): ${truncate(userTurn, 50)}`,
      payload: { changes: { introFinetuneExamples: next } },
      diff_preview: finetuneDiff(
        "Intro — finetune examples (negative / no route)",
        "Intro",
        negatives,
        next,
      ),
    };
  }

  if (routesTo === "faq") {
    if (!snapshot.faqNodeId) return error("Agent has no FAQ node — cannot route there.");
    const newEx: FinetuneExample = {
      transcript: newTranscript,
      type: "positive",
      destination_node_id: snapshot.faqNodeId,
    };
    const next = [...snapshot.introFinetuneExamples, newEx];
    return {
      ok: true,
      description: `Add intro finetune routing to FAQ: ${truncate(userTurn, 50)}`,
      // No save-and-publish field exists today for FAQ-routed intro
      // examples; surface as advisory until the route adds support.
      payload: { changes: {} },
      diff_preview: finetuneDiff(
        "Intro — finetune examples (routes to FAQ)",
        "Intro",
        snapshot.introFinetuneExamples,
        next,
      ),
    };
  }

  // Path-routed example — uses changes.transitionFinetunes[pathName].
  const path = snapshot.paths.find((p) => p.name === routesTo);
  if (!path) return error(`add_intro_finetune: path "${routesTo}" not found.`);
  const existingForPath = snapshot.introFinetuneExamples.filter(
    (ex) => ex.destination_node_id === path.transitionNodeId,
  );
  const newEx: FinetuneExample = { transcript: newTranscript, type: "positive" };
  const next = [...existingForPath, newEx];
  return {
    ok: true,
    description: `Add intro finetune routing to "${routesTo}": ${truncate(userTurn, 50)}`,
    payload: { changes: { transitionFinetunes: { [routesTo]: next } } },
    diff_preview: finetuneDiff(
      `Intro — finetune examples (routes to ${routesTo})`,
      "Intro",
      existingForPath,
      next,
    ),
  };
}

function applyEditCollectPrompt(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const append = readString(proposed.payload.append);
  if (!append) return error("edit_collect_prompt: payload.append must be a non-empty string");
  const variableName = proposed.target_variable_name;
  if (!variableName) return error("edit_collect_prompt requires target_variable_name");

  const dp = findDataPoint(snapshot, variableName);
  if (!dp) return error(`Variable "${variableName}" not found on any path.`);

  const current = dp.conversationPrompt;
  if (current.includes(append.trim())) return error("Collect prompt already contains this addition.");
  const merged = mergeAppend(current, append);
  return {
    ok: true,
    description: `Append to ${dp.label} collect prompt: ${truncate(append, 80)}`,
    payload: { changes: { nodePrompts: { [dp.collectNodeId]: merged } } },
    diff_preview: textDiff(
      "conversation_prompt",
      `Collect ${dp.label} — conversation prompt`,
      `Collect ${dp.label}`,
      current,
      merged,
    ),
  };
}

function applyAddCollectFinetune(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const userTurn = readString(proposed.payload.user);
  const agentTurn = readString(proposed.payload.agent);
  if (!userTurn || !agentTurn) {
    return error("add_collect_finetune: payload.user and payload.agent must both be non-empty strings");
  }
  const variableName = proposed.target_variable_name;
  if (!variableName) return error("add_collect_finetune requires target_variable_name");

  const dp = findDataPoint(snapshot, variableName);
  if (!dp) return error(`Variable "${variableName}" not found on any path.`);

  const newTranscript = buildExampleTranscript(userTurn, agentTurn);
  if (dp.finetuneExamples.some((ex) => transcriptEquals(ex.transcript, newTranscript))) {
    return error("An equivalent finetune example already exists on this collect node.");
  }
  const newEx: FinetuneExample = { transcript: newTranscript, type: "positive" };
  const next = [...dp.finetuneExamples, newEx];

  return {
    ok: true,
    description: `Add finetune to Collect ${dp.label} (${truncate(userTurn, 50)})`,
    payload: { changes: { dataPointFinetunes: { [dp.collectNodeId]: next } } },
    diff_preview: finetuneDiff(
      `Collect ${dp.label} — finetune examples`,
      `Collect ${dp.label}`,
      dp.finetuneExamples,
      next,
    ),
  };
}

function applyEditClosePrompt(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const append = readString(proposed.payload.append);
  if (!append) return error("edit_close_prompt: payload.append must be a non-empty string");
  const pathName = proposed.target_path_name;
  if (!pathName) return error("edit_close_prompt requires target_path_name");
  const path = snapshot.paths.find((p) => p.name === pathName);
  if (!path) return error(`Path "${pathName}" not found.`);
  const current = path.closePrompt ?? "";
  if (current.includes(append.trim())) return error("Close prompt already contains this addition.");
  const merged = mergeAppend(current, append);
  return {
    ok: true,
    description: `Append to ${pathName} close prompt: ${truncate(append, 80)}`,
    payload: { changes: { pathClosePrompts: { [pathName]: merged } } },
    diff_preview: textDiff(
      "conversation_prompt",
      `Close (${pathName}) — conversation prompt`,
      `Close (${pathName})`,
      current,
      merged,
    ),
  };
}

// ── Diff helpers ────────────────────────────────────────────────────────────

function textDiff(
  componentKind: ComponentKind,
  componentLabel: string,
  nodeLabel: string,
  before: string,
  after: string,
): DiffPreview {
  return { component_kind: componentKind, component_label: componentLabel, node_label: nodeLabel, before, after };
}

function finetuneDiff(
  componentLabel: string,
  nodeLabel: string,
  before: FinetuneExample[],
  after: FinetuneExample[],
): DiffPreview {
  return {
    component_kind: "finetune_examples",
    component_label: componentLabel,
    node_label: nodeLabel,
    before: formatFinetuneList(before),
    after: formatFinetuneList(after),
  };
}

function formatFinetuneList(examples: FinetuneExample[]): string {
  if (examples.length === 0) return "(no examples yet)";
  return examples
    .map((ex, i) => `#${i + 1} [${ex.type ?? "positive"}]\n${formatTranscript(ex.transcript)}`)
    .join("\n\n---\n\n");
}

function formatTranscript(transcript: FinetuneExample["transcript"]): string {
  return transcript.map((t) => `[${t.role}]: ${t.content}`).join("\n");
}

function buildExampleTranscript(userTurn: string, agentTurn: string): FinetuneExample["transcript"] {
  return [
    { content: userTurn, role: "user" },
    { content: agentTurn, role: "agent" },
  ];
}

function transcriptEquals(
  a: FinetuneExample["transcript"],
  b: FinetuneExample["transcript"],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((t, i) => t.role === b[i].role && t.content === b[i].content);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function findDataPoint(
  snapshot: ApplierSnapshot,
  variableName: string,
): ApplierSnapshot["paths"][number]["dataPoints"][number] | undefined {
  for (const p of snapshot.paths) {
    const found = p.dataPoints.find((d) => d.variableName === variableName);
    if (found) return found;
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mergeAppend(current: string, addition: string): string {
  return current.trim() ? `${current.trim()}\n\n${addition.trim()}` : addition.trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function error(msg: string): ApplyError {
  return { ok: false, error: msg };
}

function assertNever(x: never): ApplyError {
  return { ok: false, error: `Unsupported proposed_change kind: ${String(x as ProposedChangeKind)}` };
}

// ── Snapshot builder ────────────────────────────────────────────────────────

const FAQ_PREFIX =
  "Your goal is to answer administrative and general questions briefly and accurately.\n\n";

export function buildSnapshotFromCanonical(
  canonicalJson: Record<string, unknown>,
): ApplierSnapshot {
  const parsed = parseConversationFlow(canonicalJson);

  // FAQ
  let faqKnowledgeBase: string | undefined;
  let faqNodeId: string | undefined;
  if (parsed.faqNode) {
    faqNodeId = parsed.faqNode.id;
    const instr = parsed.faqNode.raw.instruction as Record<string, unknown> | undefined;
    const fullText = (instr?.text as string) ?? "";
    faqKnowledgeBase = fullText.startsWith(FAQ_PREFIX) ? fullText.slice(FAQ_PREFIX.length) : fullText;
  }

  // Intro
  const introNodeId = parsed.introNode.id;
  const introInstr = parsed.introNode.raw.instruction as Record<string, unknown> | undefined;
  const introPrompt = (introInstr?.text as string) ?? "";
  const introFinetuneExamples = readNodeFinetunes(parsed.introNode.raw);

  // Per-path transition prompts (intro→path edge)
  const introEdges = (parsed.introNode.raw.edges as Array<Record<string, unknown>>) ?? [];

  // Global prompt
  const globalPrompt = parsed.globalPrompt;

  return {
    globalPrompt,
    faqKnowledgeBase,
    faqNodeId,
    introNodeId,
    introPrompt,
    introFinetuneExamples,
    paths: parsed.paths.map((p) => {
      const edge = introEdges.find((e) => e.destination_node_id === p.transitionNode.id);
      const tc = edge?.transition_condition as Record<string, unknown> | undefined;
      const transitionPrompt = (tc?.prompt as string) ?? "";
      return {
        name: p.name,
        transitionNodeId: p.transitionNode.id,
        transitionPrompt,
        closeNodeId: p.closeNode?.id,
        closePrompt: p.endMode === "callback" ? (p.closePrompt ?? "") : undefined,
        dataPoints: p.dataChain.map((dp) => ({
          variableName: dp.variableName,
          label: dp.label,
          collectNodeId: dp.collectNode.id,
          conversationPrompt: dp.conversationPrompt,
          finetuneExamples: readNodeFinetunes(dp.collectNode.raw),
        })),
      };
    }),
  };
}

function readNodeFinetunes(node: Record<string, unknown>): FinetuneExample[] {
  const arr = (node.finetune_transition_examples as Array<Record<string, unknown>>) ?? [];
  return arr.map((ex) => ({
    id: ex.id as string | undefined,
    transcript: (ex.transcript as FinetuneExample["transcript"]) ?? [],
    type: ex.destination_node_id ? "positive" : "negative",
    destination_node_id: ex.destination_node_id as string | undefined,
  }));
}
