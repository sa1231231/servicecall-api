// Markdown report generator. Writes REPORT.md next to the per-scenario
// JSON files inside `tools/qa-sim/runs/<timestamp>/`. If a baseline run
// exists at `tools/qa-sim/runs/baseline/REPORT.md`, also computes a diff
// section so the operator can see whether the current run improved or
// regressed against the last promoted snapshot.
//
// Operator workflow: run sim → look at REPORT.md → if happy with the
// quality, `cp -r tools/qa-sim/runs/<ts> tools/qa-sim/runs/baseline`.
// Subsequent runs auto-diff against that.

import { promises as fs } from "fs";
import path from "path";
import type { ScenarioRun } from "./runner.js";
import type { GradeResult, AcceptanceResult } from "./grader.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReportInput {
  agentSlug: string;
  voiceAgentId: string;
  startedAt: string;
  finishedAt: string;
  results: Array<{ run: ScenarioRun; grade: GradeResult }>;
}

interface FindingCounts {
  [type: string]: number;
}

interface AcceptanceTotals {
  total: number;
  met: number;
  not_met: number;
  partial: number;
  unknown: number;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function writeReport(
  input: ReportInput,
  runDir: string,
  baselineDir?: string,
): Promise<string> {
  const md = await buildMarkdown(input, baselineDir);
  const reportPath = path.join(runDir, "REPORT.md");
  await fs.writeFile(reportPath, md, "utf8");
  return reportPath;
}

// ── Markdown builder ───────────────────────────────────────────────────────

async function buildMarkdown(input: ReportInput, baselineDir?: string): Promise<string> {
  const { agentSlug, voiceAgentId, startedAt, finishedAt, results } = input;
  const findings = totalFindings(results);
  const acceptance = totalAcceptance(results);
  const avgTurns =
    results.length > 0
      ? Math.round(
          results.reduce((acc, r) => acc + r.run.turnCount, 0) / results.length,
        )
      : 0;

  const lines: string[] = [];
  lines.push(`# QA Sim Run — ${agentSlug}`);
  lines.push(``);
  lines.push(`Agent: \`${voiceAgentId}\``);
  lines.push(`Started: ${startedAt}`);
  lines.push(`Finished: ${finishedAt}`);
  lines.push(``);

  // ── Summary ─────────────────────────────────────────────────────────────
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`- Scenarios: ${results.length}`);
  lines.push(`- Average caller turns: ${avgTurns}`);
  lines.push(
    `- Acceptance criteria: ${acceptance.met}/${acceptance.total} met` +
      ` · ${acceptance.not_met} not met` +
      ` · ${acceptance.partial} partial` +
      ` · ${acceptance.unknown} unknown`,
  );
  lines.push(``);

  // ── Findings tally ──────────────────────────────────────────────────────
  lines.push(`## Findings by type`);
  lines.push(``);
  if (Object.keys(findings).length === 0) {
    lines.push(`_No findings — every scenario looks clean._`);
  } else {
    for (const [type, count] of Object.entries(findings).sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`- **${type}**: ${count}`);
    }
  }
  lines.push(``);

  // ── Per scenario ────────────────────────────────────────────────────────
  lines.push(`## Per scenario`);
  lines.push(``);
  for (const { run, grade } of results) {
    const passCount = grade.acceptance.filter((a) => a.verdict === "met").length;
    const totalCount = grade.acceptance.length;
    const overall =
      passCount === totalCount
        ? "✅ PASS"
        : passCount === 0
          ? "❌ FAIL"
          : "⚠️  PARTIAL";

    lines.push(`### ${run.scenarioId} — ${run.scenarioLabel} (${overall})`);
    lines.push(``);
    lines.push(
      `- Persona: \`${run.personaId}\` · Caller turns: ${run.turnCount} · Ended by: \`${run.endedBy}\``,
    );
    if (run.errorMessage) {
      lines.push(`- ⚠️ Error: ${run.errorMessage}`);
    }
    if (!grade.analyzerOk && grade.analyzerError) {
      lines.push(`- ⚠️ Analyzer error: ${grade.analyzerError}`);
    }
    if (grade.acceptanceError) {
      lines.push(`- ⚠️ Acceptance grader error: ${grade.acceptanceError}`);
    }
    lines.push(``);

    // Acceptance breakdown
    lines.push(`**Acceptance criteria:**`);
    lines.push(``);
    for (const a of grade.acceptance) {
      lines.push(`- ${verdictIcon(a.verdict)} ${a.criterion}`);
      if (a.reason) lines.push(`  - _${a.reason}_`);
    }
    lines.push(``);

    // Findings
    if (grade.findings.length > 0) {
      lines.push(`**Findings (${grade.findings.length}):**`);
      lines.push(``);
      for (const f of grade.findings) {
        lines.push(`- **${f.type}** (${f.severity}): ${f.description}`);
        if (f.transcript_excerpt) {
          lines.push(`  > ${truncate(f.transcript_excerpt, 200)}`);
        }
      }
      lines.push(``);
    }

    // Transcript snippet (first 6 turns) for quick eyeballing
    const head = run.transcript.slice(0, 6);
    if (head.length > 0) {
      lines.push(`<details><summary>Transcript (first ${head.length} turns)</summary>`);
      lines.push(``);
      for (const t of head) {
        const speaker = t.speaker === "agent" ? "**Agent**" : "**Caller**";
        lines.push(`- ${speaker}: ${truncate(t.text, 240)}`);
      }
      if (run.transcript.length > head.length) {
        lines.push(`- _… (${run.transcript.length - head.length} more turns)_`);
      }
      lines.push(``);
      lines.push(`</details>`);
      lines.push(``);
    }
  }

  // ── Diff vs baseline ────────────────────────────────────────────────────
  if (baselineDir) {
    const baselineDiff = await buildBaselineDiff(baselineDir, findings, acceptance);
    if (baselineDiff) {
      lines.push(`## Diff vs baseline`);
      lines.push(``);
      lines.push(baselineDiff);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

// ── Aggregations ───────────────────────────────────────────────────────────

function totalFindings(
  results: ReportInput["results"],
): FindingCounts {
  const counts: FindingCounts = {};
  for (const { grade } of results) {
    for (const f of grade.findings) {
      counts[f.type] = (counts[f.type] ?? 0) + 1;
    }
  }
  return counts;
}

function totalAcceptance(results: ReportInput["results"]): AcceptanceTotals {
  const t: AcceptanceTotals = { total: 0, met: 0, not_met: 0, partial: 0, unknown: 0 };
  for (const { grade } of results) {
    for (const a of grade.acceptance) {
      t.total++;
      t[a.verdict as keyof AcceptanceTotals]++;
    }
  }
  return t;
}

function verdictIcon(v: AcceptanceResult["verdict"]): string {
  return v === "met" ? "✅" : v === "not_met" ? "❌" : v === "partial" ? "⚠️ " : "❔";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

// ── Baseline diff ──────────────────────────────────────────────────────────

async function buildBaselineDiff(
  baselineDir: string,
  currentFindings: FindingCounts,
  currentAcceptance: AcceptanceTotals,
): Promise<string | null> {
  let baselineReport: string;
  try {
    baselineReport = await fs.readFile(path.join(baselineDir, "REPORT.md"), "utf8");
  } catch {
    return `_No baseline at \`${baselineDir}\`. Promote a run with \`cp -r tools/qa-sim/runs/<ts> tools/qa-sim/runs/baseline\` to enable diff._`;
  }

  // Parse baseline counts out of its Summary + Findings tally sections.
  const baselineFindings = parseFindingsFromMarkdown(baselineReport);
  const baselineAcceptance = parseAcceptanceFromMarkdown(baselineReport);

  const lines: string[] = [];

  // Acceptance shift.
  if (baselineAcceptance) {
    const metDelta = currentAcceptance.met - baselineAcceptance.met;
    const failDelta = currentAcceptance.not_met - baselineAcceptance.not_met;
    lines.push(
      `- Met: ${baselineAcceptance.met} → ${currentAcceptance.met} ` +
        deltaIcon(metDelta, /*higher_is_better=*/ true),
    );
    lines.push(
      `- Not met: ${baselineAcceptance.not_met} → ${currentAcceptance.not_met} ` +
        deltaIcon(failDelta, /*higher_is_better=*/ false),
    );
  }

  // Findings shift per type.
  const allTypes = new Set([
    ...Object.keys(currentFindings),
    ...Object.keys(baselineFindings),
  ]);
  if (allTypes.size > 0) {
    lines.push(``);
    lines.push(`**Findings shift:**`);
    for (const t of allTypes) {
      const cur = currentFindings[t] ?? 0;
      const base = baselineFindings[t] ?? 0;
      if (cur === base) continue;
      const delta = cur - base;
      lines.push(`- **${t}**: ${base} → ${cur} ${deltaIcon(delta, false)}`);
    }
  }

  return lines.join("\n") || `_No measurable shift vs baseline._`;
}

function deltaIcon(delta: number, higherIsBetter: boolean): string {
  if (delta === 0) return `(no change)`;
  const good = higherIsBetter ? delta > 0 : delta < 0;
  const sign = delta > 0 ? `+${delta}` : `${delta}`;
  return good ? `✅ (${sign})` : `⚠️  (${sign})`;
}

// ── Parsing baseline counts back out of its markdown ───────────────────────

function parseFindingsFromMarkdown(md: string): FindingCounts {
  const counts: FindingCounts = {};
  const m = md.match(/## Findings by type\n([\s\S]*?)\n##/);
  if (!m) return counts;
  for (const line of m[1].split("\n")) {
    const lm = line.match(/^- \*\*([\w_]+)\*\*: (\d+)/);
    if (lm) counts[lm[1]] = parseInt(lm[2], 10);
  }
  return counts;
}

function parseAcceptanceFromMarkdown(md: string): AcceptanceTotals | null {
  const m = md.match(
    /Acceptance criteria: (\d+)\/(\d+) met · (\d+) not met · (\d+) partial · (\d+) unknown/,
  );
  if (!m) return null;
  return {
    met: parseInt(m[1], 10),
    total: parseInt(m[2], 10),
    not_met: parseInt(m[3], 10),
    partial: parseInt(m[4], 10),
    unknown: parseInt(m[5], 10),
  };
}
