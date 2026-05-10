// Maps a `proposed_change` from the analyzer into the `changes` body that
// the existing `save-and-publish` endpoint accepts. Pure function — no I/O.
//
// Append-not-replace policy: every kind that *could* destroy operator-
// authored content (FAQ, close prompts, finetune arrays, collect prompts)
// reads the current value off `currentSnapshot` and produces a NEW value
// that incorporates it. The applier never replaces wholesale.

import type { ProposedChange, ProposedChangeKind } from "./call-findings.js";
import { parseConversationFlow } from "./node-parser.js";

// ── Shape of the snapshot the applier reads from ────────────────────────────
//
// This is a subset of what `GET /dashboard/api/agents/:slug/nodes/:agentId`
// returns. The approve route handler is responsible for fetching it before
// calling the applier — keeping the applier pure makes it trivial to unit-
// test with hand-rolled fixtures.

export interface ApplierSnapshot {
  faqKnowledgeBase?: string;
  paths: Array<{
    name: string;
    closePrompt?: string;
    dataPoints: Array<{
      variableName: string;
      collectNodeId: string;
      conversationPrompt: string;
      finetuneExamples: Array<{ id?: string; transcript: string; type?: "positive" | "negative" }>;
    }>;
  }>;
}

// Shape that save-and-publish accepts; we intentionally type loosely to
// avoid coupling to that endpoint's internal types.
export interface PublishPayload {
  changes: Record<string, unknown>;
}

// ── Result types ────────────────────────────────────────────────────────────

export interface ApplyResult {
  ok: true;
  payload: PublishPayload;
  /** Plain-English description of what will be published. Used in audit log. */
  description: string;
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
  switch (proposed.kind) {
    case "add_faq_entry":
      return applyAddFaqEntry(proposed, snapshot);
    case "edit_collect_prompt":
      return applyEditCollectPrompt(proposed, snapshot);
    case "add_finetune_example":
      return applyAddFinetuneExample(proposed, snapshot);
    case "edit_close_transition":
      return applyEditCloseTransition(proposed, snapshot);
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
    default:
      return assertNever(proposed.kind);
  }
}

// ── Per-kind handlers ───────────────────────────────────────────────────────

function applyAddFaqEntry(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const entry = readString(proposed.payload.entry);
  if (!entry) return { ok: false, error: "add_faq_entry: payload.entry must be a non-empty string" };

  const current = snapshot.faqKnowledgeBase ?? "";
  // Idempotency: if the entry's exact text is already present, skip.
  if (current.includes(entry.trim())) {
    return { ok: false, error: "FAQ already contains this entry — skipping to avoid duplicate." };
  }
  const merged = current.trim()
    ? `${current.trim()}\n\n${entry.trim()}`
    : entry.trim();
  return {
    ok: true,
    description: `Add FAQ entry: ${truncate(entry, 80)}`,
    payload: { changes: { faqKnowledgeBase: merged } },
  };
}

function applyEditCollectPrompt(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const append = readString(proposed.payload.append);
  if (!append) return { ok: false, error: "edit_collect_prompt: payload.append must be a non-empty string" };
  const variableName = proposed.target_variable_name;
  if (!variableName) return { ok: false, error: "edit_collect_prompt requires target_variable_name" };

  let dp: ApplierSnapshot["paths"][number]["dataPoints"][number] | undefined;
  for (const p of snapshot.paths) {
    const found = p.dataPoints.find((d) => d.variableName === variableName);
    if (found) {
      dp = found;
      break;
    }
  }
  if (!dp) {
    return { ok: false, error: `edit_collect_prompt: variable "${variableName}" not found on any path` };
  }

  if (dp.conversationPrompt.includes(append.trim())) {
    return { ok: false, error: "Collect prompt already contains this addition — skipping." };
  }

  const newPrompt = dp.conversationPrompt.trim()
    ? `${dp.conversationPrompt.trim()}\n\n${append.trim()}`
    : append.trim();

  // save-and-publish edits a node's prompt via `changes.nodePrompts[nodeId]`
  // (see node-editor.ts:2226). That replaces the node's instruction.text
  // wholesale — we hand it the merged value so existing content is preserved.
  return {
    ok: true,
    description: `Append to Collect ${variableName} prompt: ${truncate(append, 80)}`,
    payload: { changes: { nodePrompts: { [dp.collectNodeId]: newPrompt } } },
  };
}

function applyAddFinetuneExample(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const userTurn = readString((proposed.payload as Record<string, unknown>).user);
  const agentTurn = readString((proposed.payload as Record<string, unknown>).agent);
  if (!userTurn || !agentTurn) {
    return { ok: false, error: "add_finetune_example: payload.user and payload.agent must both be non-empty strings" };
  }
  const variableName = proposed.target_variable_name;
  if (!variableName) return { ok: false, error: "add_finetune_example requires target_variable_name" };

  let dp: ApplierSnapshot["paths"][number]["dataPoints"][number] | undefined;
  for (const p of snapshot.paths) {
    const found = p.dataPoints.find((d) => d.variableName === variableName);
    if (found) {
      dp = found;
      break;
    }
  }
  if (!dp) {
    return { ok: false, error: `add_finetune_example: variable "${variableName}" not found on any path` };
  }

  // Build the example using the same transcript shape the existing finetune
  // editor uses — see node-editor-finetunes.test.ts. The ID is filled in by
  // save-and-publish if absent.
  const transcript = `[user]: ${userTurn}\n[agent]: ${agentTurn}`;

  // Idempotency: skip if any existing example has the same transcript.
  if (dp.finetuneExamples.some((ex) => ex.transcript === transcript)) {
    return { ok: false, error: "An equivalent finetune example already exists — skipping." };
  }

  const merged = [...dp.finetuneExamples, { transcript, type: "positive" as const }];

  return {
    ok: true,
    description: `Add finetune example to Collect ${variableName} (${truncate(userTurn, 50)})`,
    payload: { changes: { dataPointFinetunes: { [dp.collectNodeId]: merged } } },
  };
}

function applyEditCloseTransition(proposed: ProposedChange, snapshot: ApplierSnapshot): ApplyResultOrError {
  const append = readString(proposed.payload.append);
  if (!append) return { ok: false, error: "edit_close_transition: payload.append must be a non-empty string" };
  const pathName = proposed.target_path_name;
  if (!pathName) return { ok: false, error: "edit_close_transition requires target_path_name" };

  const path = snapshot.paths.find((p) => p.name === pathName);
  if (!path) return { ok: false, error: `edit_close_transition: path "${pathName}" not found` };

  const current = path.closePrompt ?? "";
  if (current.includes(append.trim())) {
    return { ok: false, error: "Close prompt already contains this addition — skipping." };
  }
  const merged = current.trim()
    ? `${current.trim()}\n\n${append.trim()}`
    : append.trim();
  return {
    ok: true,
    description: `Append to ${pathName} close prompt: ${truncate(append, 80)}`,
    payload: { changes: { pathClosePrompts: { [pathName]: merged } } },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function assertNever(x: never): ApplyError {
  return { ok: false, error: `Unsupported proposed_change kind: ${String(x as ProposedChangeKind)}` };
}

// ── Snapshot builder ────────────────────────────────────────────────────────
//
// Derives the minimal ApplierSnapshot the applier needs from the agent's
// canonical JSON. Keeps the route handler free of node-parser plumbing.

const FAQ_PREFIX =
  "Your goal is to answer administrative and general questions briefly and accurately.\n\n";

export function buildSnapshotFromCanonical(
  canonicalJson: Record<string, unknown>,
): ApplierSnapshot {
  const parsed = parseConversationFlow(canonicalJson);

  let faqKnowledgeBase: string | undefined;
  if (parsed.faqNode) {
    const instr = parsed.faqNode.raw.instruction as Record<string, unknown> | undefined;
    const fullText = (instr?.text as string) ?? "";
    faqKnowledgeBase = fullText.startsWith(FAQ_PREFIX) ? fullText.slice(FAQ_PREFIX.length) : fullText;
  }

  return {
    faqKnowledgeBase,
    paths: parsed.paths.map((p) => ({
      name: p.name,
      closePrompt: p.endMode === "callback" ? (p.closePrompt ?? "") : undefined,
      dataPoints: p.dataChain.map((dp) => ({
        variableName: dp.variableName,
        collectNodeId: dp.collectNode.id,
        conversationPrompt: dp.conversationPrompt,
        finetuneExamples: readNodeFinetunes(dp.collectNode.raw),
      })),
    })),
  };
}

function readNodeFinetunes(
  node: Record<string, unknown>,
): Array<{ id?: string; transcript: string; type?: "positive" | "negative" }> {
  const arr = (node.finetune_transition_examples as Array<Record<string, unknown>>) ?? [];
  return arr.map((ex) => ({
    id: ex.id as string | undefined,
    transcript: ex.transcript as string,
    type: ex.destination_node_id ? "positive" : "negative",
  }));
}
