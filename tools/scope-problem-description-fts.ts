// One-shot: separate the problem_description workspace default's vertical-
// specific fine-tunes from the generic one.
//
// Today the workspace default carries 3 FTs:
//   1. HVAC-specific  ("My heating stopped working.")
//   2. Truck-specific ("The engine overheated.")
//   3. Generic        ("I'm not really sure what the problem is.")
// Every template that references `problem_description` inherits all three.
// We want #1 to live on the HVAC Default draft as a per-template override
// (only HVAC agents see it), #2 to drop (no truck template yet — the FT
// content is preserved on truck_problem_description's default if a future
// truck template wants it), and #3 to stay on the workspace default as the
// universal baseline.
//
// Idempotent: re-running is a no-op once the move is applied. Dry-run by
// default; --apply to commit.
//
// Run:
//   railway run npx tsx tools/scope-problem-description-fts.ts
//   railway run npx tsx tools/scope-problem-description-fts.ts --apply

import "dotenv/config";
import { initDb, getDb } from "../src/lib/db.js";

const HVAC_UTTERANCE = "My heating stopped working.";
const TRUCK_UTTERANCE = "The engine overheated.";
const GENERIC_UTTERANCE = "I'm not really sure what the problem is.";

type Transcript = Array<{ role: string; content: string }>;
type Finetune = { type?: string; transcript: Transcript };

function userUtterance(ex: Finetune): string {
  return (ex.transcript ?? []).find((t) => t.role === "user")?.content?.trim() ?? "";
}

function isHvacFt(ex: Finetune): boolean {
  return userUtterance(ex) === HVAC_UTTERANCE.trim();
}
function isTruckFt(ex: Finetune): boolean {
  return userUtterance(ex) === TRUCK_UTTERANCE.trim();
}
function isGenericFt(ex: Finetune): boolean {
  return userUtterance(ex) === GENERIC_UTTERANCE.trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  await initDb();
  const db = getDb();

  // ── 1. Read current state ────────────────────────────────────────────────
  const problemDp: any = await db
    .collection("data_point_defaults")
    .findOne({ _id: "problem_description" as any });
  if (!problemDp) {
    console.error("problem_description default not found.");
    process.exit(1);
  }
  const currentFts: Finetune[] = problemDp.finetuneExamples ?? [];

  const hvacFt = currentFts.find(isHvacFt);
  const truckFt = currentFts.find(isTruckFt);

  console.log("Current problem_description default carries:");
  for (const ex of currentFts) {
    const u = userUtterance(ex);
    const flag = isHvacFt(ex) ? "HVAC" : isTruckFt(ex) ? "TRUCK" : isGenericFt(ex) ? "GENERIC" : "OTHER";
    console.log(`  [${flag}] "${u}"`);
  }

  // ── 2. Compute the new workspace default ────────────────────────────────
  //   Keep only examples that aren't HVAC- or truck-specific. Generic stays.
  //   Other (unknown) FTs the operator may have added in the meantime: keep them.
  const newDefaultFts = currentFts.filter((ex) => !isHvacFt(ex) && !isTruckFt(ex));

  // ── 3. Plan HVAC draft update ────────────────────────────────────────────
  const hvacDraft: any = await db.collection("agent_drafts").findOne({ name: "HVAC Default" });
  if (!hvacDraft) {
    console.error("HVAC Default draft not found.");
    process.exit(1);
  }

  if (!hvacFt) {
    console.log(
      "\nNo HVAC FT found on the workspace default — nothing to move to the HVAC Default draft.",
    );
  }

  // For each path's chain (in formData.routingPaths) and dataPoints (in
  // exportConfig.paths), upgrade the bare "problem_description" string to an
  // object that carries the HVAC FT as an override. If it's already an
  // override object, merge (dedup by user-utterance) — keeps re-runs idempotent.
  const newHvacDraft = JSON.parse(JSON.stringify(hvacDraft));

  let pathHits = 0;
  function upgradeChainEntry(entry: any, hvacFinetune: Finetune): any {
    // Strings — wrap into form-side override shape ({ _ref, finetuneExamples }).
    if (entry === "problem_description") {
      pathHits++;
      return { _ref: "problem_description", finetuneExamples: [hvacFinetune] };
    }
    if (entry && typeof entry === "object" && entry._ref === "problem_description") {
      const existing: Finetune[] = entry.finetuneExamples ?? [];
      if (existing.some(isHvacFt)) return entry; // already merged
      pathHits++;
      return { ...entry, finetuneExamples: [...existing, hvacFinetune] };
    }
    return entry;
  }
  function upgradeDataPointEntry(entry: any, hvacFinetune: Finetune): any {
    // Export-side override shape uses { variableName, finetuneExamples }.
    if (entry === "problem_description") {
      pathHits++;
      return { variableName: "problem_description", finetuneExamples: [hvacFinetune] };
    }
    if (entry && typeof entry === "object" && entry.variableName === "problem_description") {
      const existing: Finetune[] = entry.finetuneExamples ?? [];
      if (existing.some(isHvacFt)) return entry;
      pathHits++;
      return { ...entry, finetuneExamples: [...existing, hvacFinetune] };
    }
    return entry;
  }

  if (hvacFt) {
    const fd = newHvacDraft.formData;
    if (Array.isArray(fd?.routingPaths)) {
      for (const p of fd.routingPaths) {
        if (Array.isArray(p.chain)) p.chain = p.chain.map((c: any) => upgradeChainEntry(c, hvacFt));
      }
    }
    const ec = newHvacDraft.exportConfig;
    if (Array.isArray(ec?.paths)) {
      for (const p of ec.paths) {
        if (Array.isArray(p.dataPoints)) p.dataPoints = p.dataPoints.map((c: any) => upgradeDataPointEntry(c, hvacFt));
      }
    }
  }

  // ── 4. Summarize the plan ────────────────────────────────────────────────
  console.log("\nPlan:");
  console.log(`  Workspace default problem_description: ${currentFts.length} → ${newDefaultFts.length} FT(s).`);
  if (hvacFt) console.log(`  HVAC Default draft: embed HVAC FT as per-template override on ${pathHits} chain/dataPoint entr${pathHits === 1 ? "y" : "ies"}.`);
  if (truckFt) console.log(`  Truck FT ("${TRUCK_UTTERANCE}"): dropped (no truck template — restore later if needed).`);
  if (!hvacFt && !truckFt) {
    console.log("  Nothing to do. The workspace default already has neither HVAC nor truck FTs.");
    process.exit(0);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to commit.");
    process.exit(0);
  }

  // ── 5. Apply ─────────────────────────────────────────────────────────────
  if (hvacFt) {
    // Use $set so we don't touch _id (immutable). Only update the two fields
    // that actually changed.
    await db.collection("agent_drafts").updateOne(
      { _id: hvacDraft._id },
      {
        $set: {
          formData: newHvacDraft.formData,
          exportConfig: newHvacDraft.exportConfig,
          updatedAt: new Date(),
        },
      },
    );
    console.log("  ✓ HVAC Default draft updated.");
  }

  await db.collection("data_point_defaults").updateOne(
    { _id: "problem_description" as any },
    { $set: { finetuneExamples: newDefaultFts } },
  );
  console.log("  ✓ Workspace default problem_description updated.");
  console.log("\nDone. Redeploy any HVAC agents to pick up the per-template HVAC FT.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("scope-problem-description-fts failed:", err?.stack ?? err);
    process.exit(1);
  });
