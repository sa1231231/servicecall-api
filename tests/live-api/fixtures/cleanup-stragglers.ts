// Standalone script: scans Mongo (via the dashboard API), Retell, and
// Twilio for any artifacts tagged with the `e2e-` prefix that are
// older than 1 hour, and forcibly cleans them up.
//
// Run: `npm run test:e2e:cleanup`
//
// The 1-hour age filter prevents this script from clobbering an in-flight
// test run. If you suspect a crashed run left state behind, you can wait
// 1 hour or override `MIN_AGE_HOURS=0` env var.

import "dotenv/config";
import { apiGet, apiFetch } from "../lib/api-client.js";
import {
  hasFullEnv,
  describeMissingEnv,
} from "../lib/env.js";
import {
  E2E_PREFIX,
  isE2eSlug,
  isE2eSlugStale,
} from "../lib/slug.js";
import {
  listNumbersWithFriendlyNamePrefix,
  releaseNumberBySid,
} from "../lib/twilio-verifier.js";
import {
  listAgentsWithNamePrefix,
  deleteAgent,
} from "../lib/retell-verifier.js";

interface SweepResult {
  mongoDeleted: string[];
  retellDeleted: string[];
  twilioReleased: string[];
  errors: string[];
}

const MIN_AGE_HOURS = process.env.MIN_AGE_HOURS != null ? Number(process.env.MIN_AGE_HOURS) : 1;

async function sweep(): Promise<SweepResult> {
  const result: SweepResult = {
    mongoDeleted: [],
    retellDeleted: [],
    twilioReleased: [],
    errors: [],
  };

  // 1. Mongo (via the deleted-agents list + active agent list)
  try {
    // Active e2e- agents (test crashed before soft-delete)
    const allAgents = await apiGet<Array<{ _id: string; name: string }>>("/dashboard/api/agents");
    for (const a of allAgents) {
      if (!isE2eSlug(a._id)) continue;
      if (!isE2eSlugStale(a._id, MIN_AGE_HOURS)) {
        console.log(`[skip] ${a._id} — too fresh (under ${MIN_AGE_HOURS}h)`);
        continue;
      }
      try {
        // Soft-delete first
        await apiFetch(`/dashboard/api/agents/${a._id}`, { method: "DELETE", expectError: true });
        // Then hard-delete (releases Twilio + Retell via releaseAgentResources)
        await apiFetch(`/dashboard/api/deleted-agents/${a._id}`, { method: "DELETE", expectError: true });
        result.mongoDeleted.push(a._id);
        console.log(`[mongo] hard-deleted ${a._id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`mongo:${a._id}: ${msg}`);
      }
    }
    // Already-soft-deleted e2e- agents (test crashed mid-cleanup)
    const deletedAgents = await apiGet<Array<{ _id: string }>>("/dashboard/api/deleted-agents");
    for (const d of deletedAgents) {
      if (!isE2eSlug(d._id)) continue;
      if (!isE2eSlugStale(d._id, MIN_AGE_HOURS)) continue;
      if (result.mongoDeleted.includes(d._id)) continue; // handled above
      try {
        await apiFetch(`/dashboard/api/deleted-agents/${d._id}`, { method: "DELETE", expectError: true });
        result.mongoDeleted.push(d._id);
        console.log(`[mongo] hard-deleted (was soft-deleted) ${d._id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`mongo-deleted:${d._id}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`mongo-list: ${msg}`);
  }

  // 2. Retell (orphan agents whose Mongo doc was already deleted but
  //    whose Retell-side cleanup didn't run for some reason)
  try {
    const stragglers = await listAgentsWithNamePrefix(E2E_PREFIX);
    for (const a of stragglers) {
      try {
        await deleteAgent(a.agent_id);
        result.retellDeleted.push(a.agent_id);
        console.log(`[retell] deleted ${a.agent_id} (${a.agent_name})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`retell:${a.agent_id}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`retell-list: ${msg}`);
  }

  // 3. Twilio (orphan numbers whose friendlyName starts with e2e-)
  try {
    const stragglers = await listNumbersWithFriendlyNamePrefix(E2E_PREFIX);
    for (const n of stragglers) {
      try {
        await releaseNumberBySid(n.sid);
        result.twilioReleased.push(n.phoneNumber);
        console.log(`[twilio] released ${n.phoneNumber} (${n.friendlyName})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`twilio:${n.phoneNumber}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`twilio-list: ${msg}`);
  }

  return result;
}

async function main(): Promise<void> {
  if (!hasFullEnv) {
    console.error("Cannot run cleanup-stragglers — env not configured.");
    console.error(describeMissingEnv());
    process.exit(2);
  }

  console.log(`[cleanup-stragglers] scanning for ${E2E_PREFIX}* artifacts older than ${MIN_AGE_HOURS}h…`);
  const r = await sweep();
  console.log("\n--- Summary ---");
  console.log(`Mongo deleted: ${r.mongoDeleted.length}`);
  console.log(`Retell deleted: ${r.retellDeleted.length}`);
  console.log(`Twilio released: ${r.twilioReleased.length}`);
  if (r.errors.length > 0) {
    console.error(`\nErrors (${r.errors.length}):`);
    for (const e of r.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("\nClean.");
}

// Only run when invoked as a script (not when imported by another module).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { sweep };
