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
import { createVersionSnapshot } from "./agent-versions.js";

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

    const agentId = doc.agent_id;
    if (!agentId) {
      skipped++;
      continue;
    }

    {
      try {
        const snapshot = await fetchRetellAgent(retell, agentId);

        // Drift detection: snapshot if significant changes detected
        const existingCanonical = doc.retell_agents?.[agentId] as Record<string, unknown> | undefined;
        if (existingCanonical) {
          if (hasSignificantDrift(existingCanonical, snapshot.canonicalJson)) {
            try {
              await createVersionSnapshot(slug, agentId, existingCanonical, "auto_sync", "Auto-sync drift detected", "system");
            } catch (snapErr) {
              console.warn(`[auto-sync] could not snapshot drift for "${slug}" agent ${agentId}:`, snapErr);
            }
          }
        }

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

        // Preserve field-level customizations (show, label, required) from existing config.
        // Build a global map from ALL existing message types so customizations
        // survive even when message_type keys change (e.g. multi-path agents).
        if (doc.message_types) {
          const customizations = new Map<string, { show?: boolean; label: string; required?: true | { equals: string | string[] } }>();
          for (const existingType of Object.values(doc.message_types)) {
            for (const f of existingType.fields) {
              if (!customizations.has(f.key)) {
                customizations.set(f.key, { show: f.show, label: f.label, required: f.required });
              }
            }
          }
          for (const newType of Object.values(jsonEntry.message_types)) {
            for (const field of newType.fields) {
              const existing = customizations.get(field.key);
              if (!existing) continue;
              if (existing.show === false) field.show = false;
              if (existing.label !== field.label) field.label = existing.label;
              if (existing.required) field.required = existing.required;
            }
          }
        }

        // Preserve message-type-level customizations (subject_template, additional_text)
        if (doc.message_types) {
          for (const [mtKey, newType] of Object.entries(jsonEntry.message_types)) {
            const existingType = doc.message_types[mtKey];
            if (!existingType) continue;
            if (existingType.subject_template !== newType.subject_template) {
              newType.subject_template = existingType.subject_template;
            }
            if (existingType.additional_text) {
              newType.additional_text = existingType.additional_text;
            }
          }
        }

        // Only update fields that come from Retell — preserve everything
        // else the user may have customized via the dashboard
        const update: Record<string, unknown> = {
          [`retell_agents.${agentId}`]: snapshot.canonicalJson,
        };

        // Only overwrite message_types if the keys still match the existing
        // config. Multi-path agents have different keys than the single-path
        // deriver produces, so skip to avoid destroying their routing structure.
        const existingKeys = Object.keys(doc.message_types || {}).sort().join(",");
        const newKeys = Object.keys(jsonEntry.message_types).sort().join(",");
        if (!doc.message_types || existingKeys === newKeys) {
          update.message_types = jsonEntry.message_types;
          update.default_message_type = jsonEntry.default_message_type;
        }
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

function hasSignificantDrift(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  const existingFlow = existing.conversationFlow as Record<string, unknown> | undefined;
  const incomingFlow = incoming.conversationFlow as Record<string, unknown> | undefined;
  if (!existingFlow || !incomingFlow) return false;

  const existingNodes = existingFlow.nodes as unknown[] | undefined;
  const incomingNodes = incomingFlow.nodes as unknown[] | undefined;
  const existingCount = Array.isArray(existingNodes) ? existingNodes.length : 0;
  const incomingCount = Array.isArray(incomingNodes) ? incomingNodes.length : 0;

  // Node count changed
  if (existingCount !== incomingCount) return true;

  // Global prompt changed
  if (existingFlow.global_prompt !== incomingFlow.global_prompt) return true;

  return false;
}
