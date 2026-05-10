// Anthropic-driven analyzer for completed-call transcripts. Detects six
// recurring failure patterns and proposes a remediation that the
// suggestion-applier can map onto the existing save-and-publish payload.
//
// Pattern-of-thought for the analyzer prompt:
//   "Read this transcript through the lens of an operator who's tuning the
//    agent's conversation flow. Find the *small number* of things you'd
//    change next, not every imperfection. Empty output is the right answer
//    when the call went well."
//
// Mirrors the SDK + parsing convention from `src/lib/enrich-lead.ts`.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { extractText, summarizeContentBlocks } from "./enrich-lead.js";
import type { CallFindingDoc, FindingType, FindingSeverity, ProposedChange, ProposedChangeKind } from "./call-findings.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnalyzerInput {
  callId: string;
  agentId: string;
  clientSlug: string;
  sourceDraft?: string;
  /** Plain-text transcript from the Retell webhook (`call.transcript`). */
  transcript: string;
  /** Per-utterance object (`call.transcript_object`) — array of
   *  `{ role: "agent" | "user", content: string, words?: ... }`. May be missing. */
  transcriptObject?: Array<Record<string, unknown>>;
  collectedVars: Record<string, unknown>;
  dynamicVars: Record<string, unknown>;
  disconnectionReason: string;
  durationMs: number;
  /** A short summary of the canonical JSON shape so the analyzer can
   *  target specific node ids / path names in `proposed_change`. Built by
   *  `buildAgentContext()` from a parsed flow. Optional — when missing the
   *  analyzer will return findings without targeted node ids and the
   *  suggestion-applier will mark them advisory-only. */
  agentContext?: string;
}

export interface AnalyzerSuccess {
  ok: true;
  findings: Array<Omit<CallFindingDoc, "call_id" | "agent_id" | "client_slug" | "source_draft" | "created_at">>;
  trace: { systemPrompt: string; userMessage: string; rawContentBlocks: string };
}

export interface AnalyzerFailure {
  ok: false;
  error: string;
  trace: { systemPrompt: string; userMessage: string; rawContentBlocks: string };
}

export type AnalyzerResult = AnalyzerSuccess | AnalyzerFailure;

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_TYPES: ReadonlySet<FindingType> = new Set([
  "unanswered_question",
  "misheard_confirmation",
  "repeated_data",
  "frustration_signal",
  "premature_termination",
  "path_misroute",
]);

const VALID_KINDS: ReadonlySet<ProposedChangeKind> = new Set([
  "edit_global_prompt",
  "add_faq_entry",
  "edit_intro_prompt",
  "edit_intro_transition",
  "add_intro_finetune",
  "edit_collect_prompt",
  "add_collect_finetune",
  "edit_close_prompt",
  "edit_router_branch",
  "split_data_point",
  // Legacy aliases retained so old findings still validate
  "add_finetune_example",
  "edit_close_transition",
]);

const VALID_SEVERITIES: ReadonlySet<FindingSeverity> = new Set(["low", "medium", "high"]);

// ── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are reviewing a completed call between an AI phone receptionist and a customer of a small service business (HVAC, plumbing, etc.). The receptionist's conversation flow is operator-edited; your job is to find moments where the flow let the customer down so the operator can patch it.

Look for these six patterns ONLY:

1. **unanswered_question** — caller asked the agent a direct question and the agent did not answer it. The agent transitioned past the question, gave a generic deflection, or repeated a script line. Severity: high if the unanswered question caused the customer to balk or hang up; medium otherwise.

2. **misheard_confirmation** — the agent's confirmation read-back of a value (name, phone, address, etc.) does not match what the caller said, AND the caller said yes anyway (or the agent moved on without re-asking). Often appears as concatenated/swapped letters. Severity: high if it's address or phone (dispatch will fail); medium otherwise.

3. **repeated_data** — the caller had to give the same piece of information more than once because the agent's Collect node failed to capture it the first time, or the Confirm node bounced back unnecessarily. Severity: low.

4. **frustration_signal** — caller used negative-sentiment language ("this is ridiculous", "forget it", "not going to work") OR hung up shortly after a long script-bound exchange. Severity: high.

5. **premature_termination** — the agent moved to the close/wrap-up before the caller was done. The caller said "wait", "actually", "one more thing", "before you go", etc., and the agent ignored it. Severity: medium.

6. **path_misroute** — the caller's intent signaled a different path than the variables router sent them down (e.g. caller wanted a quote / pricing info but was sent into the dispatch chain). Severity: medium.

Return zero findings if the call went well. Be conservative — every finding becomes an operator-facing suggestion they have to review. Aim for high precision over high recall.

For each finding, propose ONE remediation. **Strong preference order:**

1. **add_*_finetune** kinds first — finetune examples teach the agent the right pattern without hardcoding text. The operator prefers these because they shape behavior naturally. Reach for them whenever a single example transcript would teach the agent the right move.
2. **edit_*_prompt** kinds only when no finetune example would express the rule (e.g. you need to restate a constraint, add an explicit instruction, or fix a question that the prompt itself asks wrongly).
3. **edit_*_transition** only when the issue is the path-routing logic at the intro layer.
4. **add_faq_entry** when the caller asked a question that should have a stock answer.
5. Advisory kinds last.

The kind names below identify the EXACT component being edited. Each suggestion targets one component on one node so the dashboard can render an unambiguous "Editing X on Y" diff.

**Available kinds**

Agent-global:
- **edit_global_prompt** — appends to the agent's top-level system prompt. Use only for behaviors that should apply across every path. Payload: \`{ append: "..." }\`.
- **add_faq_entry** — appends an entry to the FAQ knowledge base node. Use when the caller asked a recurring informational question. Payload: \`{ entry: "Question? Short answer." }\`.

Intro node (greeting + path routing):
- **edit_intro_prompt** — appends to the intro node's conversation prompt (the greeting / triage script). Payload: \`{ append: "..." }\`.
- **edit_intro_transition** — adjusts the routing prompt on the intro→path edge. Use when the agent picked the wrong path because the routing condition was too loose or too strict. Requires \`target_path_name\`. Payload: \`{ append: "..." }\` — text appended to the existing transition prompt.
- **add_intro_finetune** — adds one finetune example to the intro node. Best tool for path-routing fixes (the analyzer's preferred remediation for path_misroute). Payload: \`{ user: "...", agent: "...", routes_to: "<path-name>" | "faq" | "negative" }\`. Use \`routes_to: "faq"\` to teach the agent to redirect admin-style questions to the FAQ node; use a path name to teach path selection; \`"negative"\` for "this is none of these".

Per-routing-path Collect node (data-point capture):
- **edit_collect_prompt** — appends to a Collect node's conversation prompt. Last resort when no finetune would express the fix. Requires \`target_variable_name\`. Payload: \`{ append: "..." }\`.
- **add_collect_finetune** — adds one finetune example to a Collect node. Preferred fix for misheard/fragmented values (spelling restarts, partial answers, etc.). Requires \`target_variable_name\`. Payload: \`{ user: "...", agent: "..." }\`.

Per-routing-path Close node (callback paths only):
- **edit_close_prompt** — appends to the Close node's conversation prompt for a specific path. Use to add an "anything else?" beat or to soften a hard close. Requires \`target_path_name\`. Payload: \`{ append: "..." }\`.

Advisory only (cannot auto-apply):
- **edit_router_branch** — describes a rule change for a router branch equation. Requires \`target_path_name\`. Payload: \`{ note: "..." }\`.
- **split_data_point** — describes splitting a composite data point into pieces. Payload: \`{ note: "..." }\`.

**Targeting tip:** when the agent context lists node ids, set \`target_node_id\` so the operator knows exactly which node will change. Always set the relevant \`target_*\` field for the kind you choose.

**Do NOT include diff_preview in your output.** The system computes the actual before/after from the live agent state — your job is the kind + payload + targets.

Output ONLY a JSON object — no prose, no fences. Schema:

\`\`\`
{
  "findings": [
    {
      "type": "unanswered_question" | "misheard_confirmation" | "repeated_data" | "frustration_signal" | "premature_termination" | "path_misroute",
      "severity": "low" | "medium" | "high",
      "transcript_excerpt": "the offending exchange, 1-3 turns, verbatim",
      "description": "1-2 plain-English sentences explaining what went wrong",
      "proposed_change": {
        "kind": "<one of the kinds above>",
        "target_node_id": "<optional, when known from the agent context>",
        "target_path_name": "<optional, when applicable>",
        "target_variable_name": "<optional, when applicable>",
        "payload": { ... }
      }
    }
  ]
}
\`\`\`

Empty findings array is the correct answer when nothing material went wrong.`;

// ── Public API ───────────────────────────────────────────────────────────────

export async function analyzeTranscript(input: AnalyzerInput): Promise<AnalyzerResult> {
  const userMessage = buildUserMessage(input);

  if (!config.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY not configured",
      trace: { systemPrompt: SYSTEM_PROMPT, userMessage, rawContentBlocks: "[]" },
    };
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  try {
    const result = await client.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      },
      { timeout: 60_000 },
    );

    const rawResponse = extractText(result);
    const rawContentBlocks = summarizeContentBlocks(result);
    const trace = { systemPrompt: SYSTEM_PROMPT, userMessage, rawContentBlocks };

    return parseAnalyzerResponse(rawResponse, trace);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      trace: { systemPrompt: SYSTEM_PROMPT, userMessage, rawContentBlocks: "[]" },
    };
  }
}

// ── User message builder ─────────────────────────────────────────────────────

function buildUserMessage(input: AnalyzerInput): string {
  const lines = [
    `Call ID: ${input.callId}`,
    `Agent ID: ${input.agentId}`,
    `Disconnection: ${input.disconnectionReason}`,
    `Duration: ${Math.round(input.durationMs / 1000)}s`,
  ];

  const collected = Object.entries(input.collectedVars).filter(([, v]) => v !== undefined && v !== "");
  if (collected.length > 0) {
    lines.push("", "## Collected variables");
    for (const [k, v] of collected) lines.push(`- ${k}: ${JSON.stringify(v)}`);
  }

  if (input.agentContext) {
    lines.push("", "## Agent flow context", input.agentContext);
  }

  lines.push("", "## Transcript", input.transcript);

  return lines.join("\n");
}

// ── Response parser ──────────────────────────────────────────────────────────
//
// Strict: any finding that doesn't conform to the schema is dropped, but the
// rest are kept. We never throw on a single malformed finding because that
// would cost the operator the entire batch.

export function parseAnalyzerResponse(
  text: string,
  trace: { systemPrompt: string; userMessage: string; rawContentBlocks: string },
): AnalyzerResult {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!stripped) {
    return { ok: true, findings: [], trace };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { ok: false, error: "analyzer response was not valid JSON", trace };
  }

  const findingsRaw = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findingsRaw)) {
    return { ok: false, error: "analyzer response missing `findings` array", trace };
  }

  const findings: AnalyzerSuccess["findings"] = [];
  for (const f of findingsRaw) {
    const validated = validateFinding(f);
    if (validated) findings.push(validated);
  }
  return { ok: true, findings, trace };
}

function validateFinding(raw: unknown): AnalyzerSuccess["findings"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const type = r.type as string;
  if (!VALID_TYPES.has(type as FindingType)) return null;

  const severity = (r.severity as string) ?? "medium";
  if (!VALID_SEVERITIES.has(severity as FindingSeverity)) return null;

  const excerpt = typeof r.transcript_excerpt === "string" ? r.transcript_excerpt : "";
  const description = typeof r.description === "string" ? r.description : "";
  if (!excerpt || !description) return null;

  const pc = r.proposed_change;
  if (!pc || typeof pc !== "object") return null;
  const p = pc as Record<string, unknown>;
  const kind = p.kind as string;
  if (!VALID_KINDS.has(kind as ProposedChangeKind)) return null;

  const payload = p.payload && typeof p.payload === "object" ? (p.payload as Record<string, unknown>) : {};

  // The analyzer no longer emits diff_preview — the orchestrator computes it
  // by running the applier against the live snapshot. We stash a placeholder
  // here so the type stays satisfied; analyzeAndPersist overwrites it before
  // persisting the finding.
  const change: ProposedChange = {
    kind: kind as ProposedChangeKind,
    payload,
    diff_preview: {
      component_kind: "conversation_prompt",
      component_label: "(pending — applier fills this in)",
      before: "",
      after: "",
    },
  };
  if (typeof p.target_node_id === "string") change.target_node_id = p.target_node_id;
  if (typeof p.target_path_name === "string") change.target_path_name = p.target_path_name;
  if (typeof p.target_variable_name === "string") change.target_variable_name = p.target_variable_name;

  return {
    type: type as FindingType,
    severity: severity as FindingSeverity,
    transcript_span: { excerpt },
    description,
    proposed_change: change,
    ai_trace: { systemPrompt: "", userMessage: "", rawContentBlocks: "" }, // filled in by caller
  };
}

// ── Agent context builder ────────────────────────────────────────────────────
//
// Optional helper: given a parsed flow, build a compact summary the analyzer
// can target with `target_node_id` / `target_path_name`. Keeps the prompt
// small while still letting the analyzer ground its remediations.

export function buildAgentContext(parsed: {
  paths: Array<{
    name: string;
    routerNode: { id: string };
    closeNode?: { id: string };
    dataChain: Array<{ variableName: string; label: string; collectNode: { id: string } }>;
  }>;
  faqNode: { id: string } | null;
}): string {
  const lines: string[] = [];
  if (parsed.faqNode) lines.push(`FAQ node id: ${parsed.faqNode.id}`);
  for (const p of parsed.paths) {
    lines.push(`Path "${p.name}":`);
    lines.push(`  router_node_id: ${p.routerNode.id}`);
    if (p.closeNode) lines.push(`  close_node_id: ${p.closeNode.id}`);
    for (const dp of p.dataChain) {
      lines.push(`  collect "${dp.label}" (var=${dp.variableName}, node_id=${dp.collectNode.id})`);
    }
  }
  return lines.join("\n");
}
