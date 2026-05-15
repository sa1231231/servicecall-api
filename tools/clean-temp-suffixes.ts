// One-shot: strip leaked TEMP-<unix-ms> suffixes from an agent's canonical
// conversation flow. Rename-test cleanup occasionally fails and the polluted
// name gets baked into the intro / global / closing prompts at publish time.
// Once the flow's stored, no edit in the dashboard or the rename-business
// endpoint scrubs it (rename-business needs to know the literal old name,
// which is fragile when multiple TEMP- suffixes have accumulated).
//
// This script walks every node's `instruction.text` field, strips `TEMP-\d+`
// tokens, normalizes whitespace, and pushes the cleaned flow back to Retell.
// Idempotent. Dry-run by default; --apply to commit.
//
// Run:
//   railway run npx tsx tools/clean-temp-suffixes.ts                     # dry run, demo-hvac2
//   railway run npx tsx tools/clean-temp-suffixes.ts --slug=demo-hvac2 --apply
//
// Env: MONGODB_URL + RETELL_API_KEY.

import "dotenv/config";
import Retell from "retell-sdk";
import { config } from "../src/config.js";
import { initDb, getDb } from "../src/lib/db.js";
import { pushFlowToRetell } from "../src/lib/retell-sync.js";
import { getClientDocument } from "../src/config/client-store.js";

function parseArg(flag: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg ? arg.slice(flag.length + 3) : null;
}

const TEMP_PATTERN = /\s*TEMP-\d+/g;

function stripTempTokens(text: string): string {
  // Remove all TEMP-<digits> tokens plus the whitespace immediately before
  // them, then collapse any double-spaces that result.
  return text.replace(TEMP_PATTERN, "").replace(/  +/g, " ");
}

function walkAndClean(obj: unknown, log: string[]): unknown {
  if (typeof obj === "string") {
    if (TEMP_PATTERN.test(obj)) {
      TEMP_PATTERN.lastIndex = 0; // reset stateful global
      const cleaned = stripTempTokens(obj);
      log.push(`replaced: "${obj.slice(0, 80)}..." → "${cleaned.slice(0, 80)}..."`);
      return cleaned;
    }
    TEMP_PATTERN.lastIndex = 0;
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => walkAndClean(item, log));
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = walkAndClean(v, log);
    }
    return out;
  }
  return obj;
}

async function main() {
  const slug = parseArg("slug") ?? "demo-hvac2";
  const apply = process.argv.includes("--apply");

  await initDb();

  const doc = await getClientDocument(slug);
  if (!doc) {
    console.error(`No client doc for slug=${slug}`);
    process.exit(1);
  }

  const agentId = doc.agent_id;
  const canonical = (doc as any).retell_agents?.[agentId];
  if (!canonical) {
    console.error(`No canonical flow stored for ${slug}/${agentId}`);
    process.exit(1);
  }

  const log: string[] = [];
  const cleaned = walkAndClean(canonical, log) as Record<string, unknown>;

  if (log.length === 0) {
    console.log(`No TEMP- suffixes found in ${slug}'s canonical flow. Nothing to do.`);
    process.exit(0);
  }

  console.log(`Found ${log.length} string(s) with TEMP- suffixes in ${slug}:`);
  for (const line of log) console.log(`  ${line}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to push the cleaned flow to Retell.");
    process.exit(0);
  }

  // Push the cleaned flow to Retell. The flow id is stored on the
  // conversationFlow sub-object (assigned by Retell at create time and
  // preserved on our cached canonical).
  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  const flowId = (cleaned.conversationFlow as any)?.conversation_flow_id;
  if (!flowId) {
    console.error("Could not determine conversation_flow_id from canonical.conversationFlow.");
    process.exit(1);
  }

  await pushFlowToRetell(retell, flowId, cleaned);

  // Persist the cleaned canonical in Mongo too so the dashboard's cached
  // copy matches what Retell has.
  await getDb()
    .collection("clients")
    .updateOne(
      { _id: slug } as any,
      { $set: { [`retell_agents.${agentId}`]: cleaned } },
    );

  console.log(`\nApplied. ${log.length} replacement(s) pushed to Retell + stored in Mongo.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("clean-temp-suffixes failed:", err?.stack ?? err);
    process.exit(1);
  });
