// One-shot: seed workspace-wide fine-tune examples on the `full_name` and
// `phone_number` data point defaults in Mongo. Mirrors the patterns from
// Home Heating that read as warmer/more competent on real calls.
//
// Idempotent: only writes to a data point whose finetuneExamples array
// is currently empty. Operator-customized data points (already have
// examples) are skipped — never destructive.
//
// Affects new-agent generation only: existing agents already have their
// per-node finetune_transition_examples copies (set at generation time
// or via the dashboard). The migrate-agent-warmth.ts script could be
// extended later to retro-fit existing agents, but per Sam's "small
// changes, test incrementally" preference, that's deferred.
//
// Run:
//   railway run npx tsx tools/seed-data-point-finetunes.ts             # dry run
//   railway run npx tsx tools/seed-data-point-finetunes.ts --apply

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import { initDb, getDb } from "../src/lib/db.js";
import type { FinetuneExample } from "../src/lib/agent-generator/data-point-registry.js";

// ── CLI ────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");

// ── Seed payloads ──────────────────────────────────────────────────────────
//
// All examples are typed "positive" → they teach the agent to accept the
// pattern + move forward to the next node. "negative" examples are
// reserved for the dashboard's per-node editing flow (they're route-
// rejection examples; less useful as workspace-wide seeds since the
// "next" destination depends on the agent's flow shape).

const SEEDS: Array<{ key: string; examples: FinetuneExample[] }> = [
  {
    key: "full_name",
    examples: [
      {
        type: "positive",
        transcript: [{ role: "user", content: "Sam" }],
      },
      {
        type: "positive",
        transcript: [{ role: "user", content: "Bernard" }],
      },
    ],
  },
  {
    key: "phone_number",
    examples: [
      {
        type: "positive",
        // Incomplete-number recovery: caller gives 7 digits, agent
        // gracefully asks for the full 10.
        transcript: [
          { role: "user", content: "My number is eight six seven five three zero nine." },
          {
            role: "agent",
            content:
              "I'm sorry, I don't think I heard the complete phone number. Could you repeat all ten digits for me?",
          },
        ],
      },
    ],
  },
];

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(APPLY ? "=== APPLY MODE ===" : "=== DRY RUN === (pass --apply to write)");

  await initDb();
  const coll = getDb().collection<{
    _id: string;
    finetuneExamples?: FinetuneExample[];
  }>("data_point_defaults");

  let seeded = 0;
  let skipped = 0;

  for (const { key, examples } of SEEDS) {
    const doc = await coll.findOne({ _id: key } as never);
    if (!doc) {
      console.log(`  [missing] ${key} — no row in data_point_defaults, cannot seed`);
      skipped++;
      continue;
    }
    const existing = doc.finetuneExamples ?? [];
    if (existing.length > 0) {
      console.log(
        `  [skipped] ${key} — already has ${existing.length} example(s), not touching`,
      );
      skipped++;
      continue;
    }
    console.log(`  [seed]    ${key} — adding ${examples.length} example(s)`);
    if (APPLY) {
      await coll.updateOne(
        { _id: key } as never,
        { $set: { finetuneExamples: examples } },
      );
    }
    seeded++;
  }

  console.log("\n=== Summary ===");
  console.log(`  seeded:  ${seeded}`);
  console.log(`  skipped: ${skipped}`);
  if (!APPLY) console.log("\nRe-run with --apply to write.");
}

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
