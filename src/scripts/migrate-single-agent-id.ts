// One-shot migration: collapse `agent_ids: string[]` (legacy) into `agent_id: string`.
// Run once after deploying the single-agent code:
//   npx tsx src/scripts/migrate-single-agent-id.ts        (dry run, default)
//   npx tsx src/scripts/migrate-single-agent-id.ts --apply (write changes)
//
// Idempotent — re-running after success reports zero migrations.

import { MongoClient } from "mongodb";
import { config } from "../config.js";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`[migrate-single-agent-id] mode: ${apply ? "APPLY" : "dry-run"}`);

  const client = new MongoClient(config.MONGODB_URL);
  await client.connect();
  const db = client.db();

  const docs = await db.collection("clients").find({}).toArray();
  console.log(`[migrate-single-agent-id] found ${docs.length} client document(s)`);

  let migrated = 0;
  let skipped = 0;
  let warnings = 0;

  for (const doc of docs) {
    const slug = doc._id;

    if (doc.agent_id && typeof doc.agent_id === "string") {
      skipped++;
      continue;
    }

    const arr = Array.isArray(doc.agent_ids) ? doc.agent_ids : [];
    const first = arr[0];
    if (!first) {
      console.warn(`[migrate-single-agent-id] WARN: "${slug}" has no agent_id and no usable agent_ids[0]`);
      warnings++;
      continue;
    }
    if (arr.length > 1) {
      console.warn(`[migrate-single-agent-id] WARN: "${slug}" had ${arr.length} agent_ids; keeping only ${first}, dropping ${arr.slice(1).join(", ")}`);
      warnings++;
    }

    if (apply) {
      await db.collection("clients").updateOne(
        { _id: doc._id },
        { $set: { agent_id: first }, $unset: { agent_ids: "" } } as any,
      );
    }
    console.log(`[migrate-single-agent-id] ${apply ? "migrated" : "would migrate"} "${slug}": agent_id="${first}"`);
    migrated++;
  }

  console.log(`[migrate-single-agent-id] summary: ${apply ? "migrated" : "would-migrate"}=${migrated}, already-on-new=${skipped}, warnings=${warnings}`);
  await client.close();
}

main().catch((err) => {
  console.error("[migrate-single-agent-id] error:", err);
  process.exit(1);
});
