// Two-pass grader for a completed scenario run.
//
// Pass A: reuse `analyzeTranscript()` from src/lib/transcript-analyzer.ts.
//         Same 6-finding-type machinery the prod transcript-review pipeline
//         uses on real calls.
//
// Pass B: scenario-specific acceptance-criteria check. One Anthropic call
//         (Sonnet 4.6, ~2K tokens) that scores each criterion as
//         met / not_met / partial with a one-sentence rationale.
//
// Output: { findings: [...analyzer...], acceptance: [{criterion, met, reason}] }
// per scenario run. The report aggregates these.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import { analyzeTranscript } from "../../src/lib/transcript-analyzer.js";
import type { ScenarioRun } from "./runner.js";
import type { Scenario } from "./scenarios.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type AcceptanceVerdict = "met" | "not_met" | "partial" | "unknown";

export interface AcceptanceResult {
  criterion: string;
  verdict: AcceptanceVerdict;
  reason: string;
}

export interface GradeResult {
  scenarioId: string;
  /** Pass-A findings shape mirrors transcript-analyzer's `findings` array. */
  findings: Awaited<ReturnType<typeof analyzeTranscript>> extends infer R
    ? R extends { ok: true; findings: infer F } ? F : never
    : never;
  /** True if analyzer ran successfully, false if it errored (e.g. empty
   *  transcript). When false, `findings` is `[]` and the error is in
   *  `analyzerError`. */
  analyzerOk: boolean;
  analyzerError?: string;
  /** Pass-B per-criterion verdicts. */
  acceptance: AcceptanceResult[];
  /** Pass-B error (if Pass-B failed). */
  acceptanceError?: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function gradeRun(
  run: ScenarioRun,
  scenario: Scenario,
): Promise<GradeResult> {
  // ── Pass A ───────────────────────────────────────────────────────────────
  // Build a plain-text transcript in the shape transcript-analyzer expects.
  const transcriptPlain = run.transcript
    .map((t) => `${t.speaker === "agent" ? "Agent" : "User"}: ${t.text}`)
    .join("\n");

  const analyzerResult = await analyzeTranscript({
    callId: `qa-sim-${run.scenarioId}`,
    agentId: run.voiceAgentId,
    clientSlug: run.agentSlug,
    transcript: transcriptPlain,
    collectedVars: run.collectedVars,
    dynamicVars: {},
    disconnectionReason: run.endedBy,
    durationMs: run.durationMs,
  });

  const findings = analyzerResult.ok ? analyzerResult.findings : [];
  const analyzerError = analyzerResult.ok ? undefined : analyzerResult.error;

  // ── Pass B ───────────────────────────────────────────────────────────────
  const acceptance = await gradeAcceptance(run, scenario);

  return {
    scenarioId: scenario.id,
    findings: findings as GradeResult["findings"],
    analyzerOk: analyzerResult.ok,
    analyzerError,
    acceptance: acceptance.results,
    acceptanceError: acceptance.error,
  };
}

// ── Pass B: acceptance-criteria grader ─────────────────────────────────────

const ACCEPTANCE_SYSTEM_PROMPT = `You are evaluating a phone-agent conversation against a checklist of behavioral acceptance criteria. For each criterion, decide whether the agent met it based ONLY on the transcript provided.

For each criterion respond with one of:
- met        — clear evidence in the transcript that the criterion was satisfied
- not_met    — clear evidence the criterion was violated, OR criterion required something to happen and it did not
- partial    — evidence is mixed (e.g. the criterion was mostly satisfied with one slip)
- unknown    — transcript is silent on this criterion; cannot tell

Be strict. "partial" is for genuine middle cases — when the agent did the right thing 80% of the way but slipped once. Don't use "partial" as a hedge.

Output STRICTLY this JSON shape on one line, no prose or markdown:

{"results": [{"criterion": "<verbatim criterion text>", "verdict": "<met|not_met|partial|unknown>", "reason": "<one short sentence>"}, ...]}

Include one entry per criterion, in the order given. Do not add or remove criteria. \`reason\` must be one short sentence (max ~20 words) citing concrete behavior from the transcript.`;

async function gradeAcceptance(
  run: ScenarioRun,
  scenario: Scenario,
): Promise<{ results: AcceptanceResult[]; error?: string }> {
  if (!config.ANTHROPIC_API_KEY) {
    return {
      results: scenario.acceptanceCriteria.map((c) => ({
        criterion: c,
        verdict: "unknown",
        reason: "ANTHROPIC_API_KEY not configured",
      })),
      error: "ANTHROPIC_API_KEY not configured",
    };
  }

  const transcriptPlain = run.transcript
    .map((t) => `${t.speaker === "agent" ? "Agent" : "Caller"}: ${t.text}`)
    .join("\n");

  const userMessage = [
    `## Scenario`,
    `${scenario.label} — goal: ${scenario.goal}`,
    "",
    `## Acceptance criteria`,
    ...scenario.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    `## Transcript`,
    transcriptPlain,
  ].join("\n");

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  try {
    const result = await client.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: [
          { type: "text", text: ACCEPTANCE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userMessage }],
      } as unknown as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: 45_000 },
    );
    const text = extractFirstText(result);
    return parseAcceptance(text, scenario.acceptanceCriteria);
  } catch (err) {
    return {
      results: scenario.acceptanceCriteria.map((c) => ({
        criterion: c,
        verdict: "unknown",
        reason: "grader call failed",
      })),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractFirstText(result: Anthropic.Message): string {
  for (const block of result.content) {
    if ("text" in block) return (block as { text: string }).text;
  }
  return "";
}

const VALID_VERDICTS: ReadonlySet<AcceptanceVerdict> = new Set([
  "met",
  "not_met",
  "partial",
  "unknown",
]);

export function parseAcceptance(
  raw: string,
  criteria: string[],
): { results: AcceptanceResult[]; error?: string } {
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return {
      results: criteria.map((c) => ({ criterion: c, verdict: "unknown", reason: "grader output not JSON" })),
      error: "grader output not JSON",
    };
  }
  const rawList = (parsed as { results?: unknown }).results;
  if (!Array.isArray(rawList)) {
    return {
      results: criteria.map((c) => ({ criterion: c, verdict: "unknown", reason: "grader output missing results array" })),
      error: "grader output missing results array",
    };
  }
  // Match each criterion to a result. The grader is asked to preserve order;
  // if it didn't, we fall back to text-match on the criterion field.
  const out: AcceptanceResult[] = [];
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i];
    let entry = rawList[i] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object" || entry.criterion !== c) {
      // Fallback: find by text match.
      entry = rawList.find((r) => (r as { criterion?: unknown }).criterion === c) as
        | Record<string, unknown>
        | undefined;
    }
    if (!entry) {
      out.push({ criterion: c, verdict: "unknown", reason: "missing from grader output" });
      continue;
    }
    const verdict = entry.verdict as string;
    const ok = VALID_VERDICTS.has(verdict as AcceptanceVerdict);
    out.push({
      criterion: c,
      verdict: ok ? (verdict as AcceptanceVerdict) : "unknown",
      reason: typeof entry.reason === "string" ? entry.reason : "",
    });
  }
  return { results: out };
}
