import Retell from "retell-sdk";
import { config } from "../config.js";
import {
  getAllClientDocuments,
  loadClientsFromDb,
} from "../config/client-store.js";
import { fetchRetellAgent } from "./retell-sync.js";
import {
  deriveNotificationConfig,
  type ClientInfo,
} from "./notification-config.js";
import { getDb } from "./db.js";
import type { JsonClientEntry } from "../config/client-store.js";

const ONE_HOUR_MS = 3_600_000;
const TWO_HOURS_MS = 2 * ONE_HOUR_MS;

export function startAutoSync(): void {
  console.log("[auto-sync] scheduled hourly Retell -> MongoDB sync");
  setInterval(runAutoSync, ONE_HOUR_MS);
}

async function runAutoSync(): Promise<void> {
  console.log("[auto-sync] starting sync run...");
  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  const docs = await getAllClientDocuments();

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of docs) {
    const slug = doc._id;

    // Guard: skip clients deployed within the last 2 hours
    if (doc.last_deployed_at) {
      const age = Date.now() - new Date(doc.last_deployed_at).getTime();
      if (age < TWO_HOURS_MS) {
        console.log(
          `[auto-sync] skipping "${slug}" (deployed ${Math.round(age / 60_000)}m ago)`,
        );
        skipped++;
        continue;
      }
    }

    const agentIds = doc.agent_ids ?? [];
    if (agentIds.length === 0) {
      skipped++;
      continue;
    }

    for (const agentId of agentIds) {
      try {
        const snapshot = await fetchRetellAgent(retell, agentId);

        // Preserve existing dispatch info
        const clientInfo: ClientInfo = {
          slug,
          name: doc.name,
          dispatch_text_numbers: doc.dispatch_text_numbers,
          dispatch_call_number: doc.dispatch_call_number,
          dispatch_email: doc.dispatch_email,
          dispatch_cc: doc.dispatch_cc,
          outbound_from_number: doc.outbound_from_number,
          summary_agent_id: doc.summary_agent_id,
          phone_fallback_to_caller: doc.phone_fallback_to_caller,
          hide_not_mentioned: doc.hide_not_mentioned,
          shadow_mode: doc.shadow_mode,
        };

        const jsonEntry = deriveNotificationConfig(
          snapshot.variables,
          clientInfo,
          agentId,
        );

        // Preserve full agent_ids array
        jsonEntry.agent_ids = doc.agent_ids;

        // Merge canonical JSON
        jsonEntry.retell_agents = {
          ...(doc.retell_agents ?? {}),
          [agentId]: snapshot.canonicalJson,
        };

        // Write directly to MongoDB — bypass persistClient to avoid
        // resetting last_deployed_at
        const update: Record<string, unknown> = { ...jsonEntry };
        delete (update as any)._id;
        await getDb()
          .collection<JsonClientEntry & { _id: string }>("clients")
          .updateOne({ _id: slug } as any, { $set: update });

        synced++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[auto-sync] error syncing "${slug}" agent ${agentId}: ${message}`,
        );
        errors++;
      }
    }
  }

  // Refresh in-memory cache from MongoDB after all writes
  if (synced > 0) {
    await loadClientsFromDb();
  }

  console.log(
    `[auto-sync] complete: ${synced} synced, ${skipped} skipped, ${errors} errors`,
  );
}
