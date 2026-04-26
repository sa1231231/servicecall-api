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

const THREE_MIN_MS = 3 * 60_000;
const TEN_MIN_MS = 10 * 60_000;

export function startAutoSync(): void {
  console.log("[auto-sync] scheduled Retell -> MongoDB sync every 3 minutes");
  setInterval(runAutoSync, THREE_MIN_MS);
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

    // Guard: skip clients deployed within the last 10 minutes
    if (doc.last_deployed_at) {
      const age = Date.now() - new Date(doc.last_deployed_at).getTime();
      if (age < TEN_MIN_MS) {
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

        // Preserve field-level customizations (show, label) from existing config
        if (doc.message_types) {
          for (const [typeKey, newType] of Object.entries(jsonEntry.message_types)) {
            const existingType = doc.message_types[typeKey];
            if (!existingType) continue;
            for (const field of newType.fields) {
              const existingField = existingType.fields.find((f) => f.key === field.key);
              if (!existingField) continue;
              if (existingField.show === false) field.show = false;
              if (existingField.label !== field.label) field.label = existingField.label;
            }
          }
        }

        // Only update fields that come from Retell — preserve everything
        // else the user may have customized via the dashboard
        const update: Record<string, unknown> = {
          message_types: jsonEntry.message_types,
          default_message_type: jsonEntry.default_message_type,
          [`retell_agents.${agentId}`]: snapshot.canonicalJson,
        };
        // Only update resolve_rule/resolve_rules if the doc doesn't have
        // manually-configured resolve_rules already
        if (!doc.resolve_rules || doc.resolve_rules.length === 0) {
          if (jsonEntry.resolve_rule) update.resolve_rule = jsonEntry.resolve_rule;
        }

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
