// CLI entry for the QA sim. Wires personas + scenarios + runner + grader +
// report together.
//
// Examples:
//   # With Mongo access (run inside Railway shell):
//   railway run npx tsx tools/qa-sim/run.ts --slug=home-heating-cooling
//
//   # Without Mongo (bypass slug lookup — useful for local R&D):
//   npx tsx tools/qa-sim/run.ts --agent-id=agent_1938d6a042d7cfa33c4db42d02 --label=home-heating
//
//   # Filter to one scenario or persona:
//   railway run npx tsx tools/qa-sim/run.ts --slug=home-heating-cooling --persona=stressed-driver
//   railway run npx tsx tools/qa-sim/run.ts --slug=home-heating-cooling --scenarios=tire-request,wrong-number-hostile
//
//   # Diff against the promoted baseline run:
//   railway run npx tsx tools/qa-sim/run.ts --slug=home-heating-cooling --against-baseline
//
// Env required: RETELL_API_KEY + ANTHROPIC_API_KEY. MONGODB_URL only when
// using --slug (otherwise pass --agent-id to skip the lookup).

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, getDb } from "../../src/lib/db.js";
import { filterScenarios } from "./scenarios.js";
import { runScenario, type ScenarioRun } from "./runner.js";
import { gradeRun, type GradeResult } from "./grader.js";
import { writeReport } from "./report.js";

// ── CLI parsing ────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=", 2)[1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

// ── Slug → agent_id lookup (via Mongo) ─────────────────────────────────────

interface ClientDoc {
  _id: string;
  agent_id?: string;
  name?: string;
}

async function lookupAgentId(slug: string): Promise<string> {
  await initDb();
  const doc = await getDb()
    .collection<ClientDoc>("clients")
    .findOne({ _id: slug as unknown as never });
  if (!doc) throw new Error(`No client found in Mongo for slug "${slug}"`);
  if (!doc.agent_id) throw new Error(`Client "${slug}" has no agent_id`);
  return doc.agent_id;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const slug = flag("slug");
  const explicitAgentId = flag("agent-id");
  const labelOverride = flag("label");
  if (!slug && !explicitAgentId) {
    console.error("Usage: tsx tools/qa-sim/run.ts --slug=<agent-slug>  (or)  --agent-id=<agent_id> --label=<label>");
    console.error("Optional: --persona=ID  --scenarios=ID,ID  --against-baseline");
    process.exit(2);
  }

  const personaId = flag("persona");
  const scenarioIdsCsv = flag("scenarios");
  const scenarioIds = scenarioIdsCsv ? scenarioIdsCsv.split(",").map((s) => s.trim()) : undefined;
  const againstBaseline = hasFlag("against-baseline");

  const scenarios = filterScenarios({ personaId, scenarioIds });
  if (scenarios.length === 0) {
    console.error(`No scenarios match (persona=${personaId ?? "any"}, scenarios=${scenarioIdsCsv ?? "any"})`);
    process.exit(2);
  }

  // --agent-id bypasses the Mongo lookup. Useful for local R&D when you
  // don't have access to prod Mongo (which is internal-only on Railway).
  const agentId = explicitAgentId ?? (await lookupAgentId(slug!));
  const reportLabel = slug ?? labelOverride ?? agentId;
  console.log(`Agent: ${agentId}`);
  console.log(`Label: ${reportLabel}`);
  console.log(`Scenarios: ${scenarios.length} (${scenarios.map((s) => s.id).join(", ")})`);

  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const runsRoot = path.join(repoRoot, "tools", "qa-sim", "runs");
  const runDir = path.join(runsRoot, runId);
  const baselineDir = path.join(runsRoot, "baseline");

  // ── Drive scenarios serially. Each prints its own progress line. ────────
  const results: Array<{ run: ScenarioRun; grade: GradeResult }> = [];
  for (let i = 0; i < scenarios.length; i++) {
    const sc = scenarios[i];
    const t0 = Date.now();
    process.stdout.write(`  [${i + 1}/${scenarios.length}] ${sc.id}… `);
    const run = await runScenario(sc, {
      agentSlug: reportLabel,
      voiceAgentId: agentId,
      runDir,
    });
    const grade = await gradeRun(run, sc);
    results.push({ run, grade });

    const passCount = grade.acceptance.filter((a) => a.verdict === "met").length;
    const totalCount = grade.acceptance.length;
    const findCount = grade.findings.length;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${passCount}/${totalCount} criteria met, ${findCount} findings, ${run.turnCount} turns, ${elapsed}s`,
    );
  }

  const finishedAt = new Date();
  const reportPath = await writeReport(
    {
      agentSlug: reportLabel,
      voiceAgentId: agentId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      results,
    },
    runDir,
    againstBaseline ? baselineDir : undefined,
  );

  console.log("");
  console.log(`Report: ${reportPath}`);
  if (!againstBaseline) {
    console.log(`Tip: promote this run with`);
    console.log(`     rm -rf tools/qa-sim/runs/baseline && cp -r ${runDir} tools/qa-sim/runs/baseline`);
    console.log(`     then re-run with --against-baseline to see diffs.`);
  }
}

// Only run when invoked directly (mirror the migrate-add-close-question.ts pattern).
const __thisFile = fileURLToPath(import.meta.url);
const __entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (__thisFile === __entryFile) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
