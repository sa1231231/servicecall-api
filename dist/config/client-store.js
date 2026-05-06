import crypto from "crypto";
import { getDb } from "../lib/db.js";
import { notificationClients, agentIdToClient, agentIdToSlug, phoneNumberToClient, } from "../_cache/clients.js";
// ── Helpers ──────────────────────────────────────────────────────────────────
export function ruleToFunction(rule, rules, defaultType) {
    // Multi-path: ordered rules, first match wins
    if (rules && rules.length > 0) {
        return (vars) => {
            for (const r of rules) {
                if (vars[r.field] === r.equals)
                    return r.then;
            }
            return defaultType;
        };
    }
    // Single binary rule (backward compat)
    if (rule) {
        return (vars) => vars[rule.field] === rule.equals ? rule.then : rule.else;
    }
    return () => defaultType;
}
export function toClientConfig(entry) {
    return {
        name: entry.name,
        agent_id: entry.agent_id,
        dispatch_text_numbers: entry.dispatch_text_numbers,
        dispatch_call_number: entry.dispatch_call_number,
        dispatch_call_overrides: entry.dispatch_call_overrides,
        dispatch_by_type: entry.dispatch_by_type,
        path_end_modes: entry.path_end_modes,
        summary_agent_id: entry.summary_agent_id,
        outbound_from_number: entry.outbound_from_number,
        dispatch_email: entry.dispatch_email,
        dispatch_cc: entry.dispatch_cc,
        resolve_type: ruleToFunction(entry.resolve_rule, entry.resolve_rules, entry.default_message_type),
        message_types: entry.message_types,
        default_message_type: entry.default_message_type,
        webhook_url: entry.webhook_url,
        notification_greeting: entry.notification_greeting,
        phone_fallback_to_caller: entry.phone_fallback_to_caller,
        hide_not_mentioned: entry.hide_not_mentioned,
        shadow_mode: entry.shadow_mode,
        active: entry.active,
    };
}
function registerInMemory(slug, config) {
    notificationClients[slug] = config;
    if (config.agent_id) {
        agentIdToClient[config.agent_id] = config;
        agentIdToSlug[config.agent_id] = slug;
    }
    if (config.outbound_from_number) {
        phoneNumberToClient[config.outbound_from_number] = { slug, config };
    }
}
// ── Collection accessor ──────────────────────────────────────────────────────
function clients() {
    return getDb().collection("clients");
}
// ── Public API ───────────────────────────────────────────────────────────────
/** Load all clients from MongoDB and populate the in-memory maps. */
export async function loadClientsFromDb() {
    const docs = await clients().find({ deletedAt: { $exists: false } }).toArray();
    for (const doc of docs) {
        const slug = doc._id;
        if (typeof doc.agent_id !== "string" || !doc.agent_id) {
            console.log(`[client-store] skipping "${slug}" (missing agent_id)`);
            continue;
        }
        const config = toClientConfig(doc);
        registerInMemory(slug, config);
    }
    console.log(`[client-store] loaded ${docs.length} client(s) from MongoDB`);
}
/** Persist a client to MongoDB and register in memory. */
export async function persistClient(slug, entry) {
    entry.last_deployed_at = new Date().toISOString();
    await clients().replaceOne({ _id: slug }, { _id: slug, ...entry }, { upsert: true });
    const config = toClientConfig(entry);
    registerInMemory(slug, config);
    console.log(`[client-store] persisted client "${slug}"`);
    return config;
}
/** Update a single field on a client in MongoDB and in memory. */
export async function updateClientField(slug, field, value) {
    const result = await clients().updateOne({ _id: slug }, { $set: { [field]: value } });
    if (result.matchedCount === 0) {
        throw new Error(`Client "${slug}" not found`);
    }
    // Update in-memory config
    const existing = notificationClients[slug];
    if (existing) {
        existing[field] = value;
    }
    console.log(`[client-store] updated "${slug}".${field} = ${JSON.stringify(value)}`);
}
// `name` is intentionally NOT in this whitelist. Renaming the business name
// must go through the rename-business handler in node-editor.ts so it
// propagates into prompts, welcome line, FAQ, etc. The dashboard label that
// users actually see is `display_name`, which has its own side-effect path
// (Retell agent_name + phone nicknames) layered on top in update-agent.ts.
const EDITABLE_FIELDS = new Set([
    "agent_id",
    "display_name",
    "dispatch_text_numbers",
    "dispatch_call_number",
    "dispatch_call_overrides",
    "dispatch_by_type",
    "path_end_modes",
    "dispatch_email",
    "dispatch_cc",
    "outbound_from_number",
    "summary_agent_id",
    "active",
    "deactivated_numbers",
    "shadow_mode",
    "hide_not_mentioned",
    "notification_greeting",
    "webhook_url",
    "weekly_report_enabled",
    "trial_start_date",
    "contact_name",
    "contact_phone",
    "contact_email",
    "contact_timezone",
    "contact_notes",
    "message_types",
    "resolve_rules",
    "folder_id",
]);
/** Update multiple fields on a client in MongoDB and in memory. */
export async function updateClientFields(slug, updates) {
    // Whitelist validation
    const setObj = {};
    for (const [key, value] of Object.entries(updates)) {
        if (!EDITABLE_FIELDS.has(key)) {
            throw new Error(`Field "${key}" is not editable`);
        }
        setObj[key] = value;
    }
    if (Object.keys(setObj).length === 0) {
        throw new Error("No valid fields to update");
    }
    const result = await clients().updateOne({ _id: slug }, { $set: setObj });
    if (result.matchedCount === 0) {
        throw new Error(`Client "${slug}" not found`);
    }
    // Update in-memory config
    const existing = notificationClients[slug];
    if (existing) {
        // Special handling for agent_id: remove old mapping first
        if ("agent_id" in setObj && existing.agent_id) {
            delete agentIdToClient[existing.agent_id];
            delete agentIdToSlug[existing.agent_id];
        }
        // Special handling for outbound_from_number: remove old mapping
        if ("outbound_from_number" in setObj && existing.outbound_from_number) {
            delete phoneNumberToClient[existing.outbound_from_number];
        }
        // Apply all field updates to in-memory object
        for (const [key, value] of Object.entries(setObj)) {
            existing[key] = value;
        }
        // Re-register agent_id if it changed
        if ("agent_id" in setObj && existing.agent_id) {
            agentIdToClient[existing.agent_id] = existing;
            agentIdToSlug[existing.agent_id] = slug;
        }
        // Re-register phone number if it changed
        if ("outbound_from_number" in setObj && existing.outbound_from_number) {
            phoneNumberToClient[existing.outbound_from_number] = { slug, config: existing };
        }
    }
    console.log(`[client-store] updated "${slug}" fields: ${Object.keys(setObj).join(", ")}`);
}
/** Remove a client from in-memory caches. */
function unregisterFromMemory(slug) {
    const existing = notificationClients[slug];
    if (existing) {
        if (existing.agent_id) {
            delete agentIdToClient[existing.agent_id];
            delete agentIdToSlug[existing.agent_id];
        }
        if (existing.outbound_from_number) {
            delete phoneNumberToClient[existing.outbound_from_number];
        }
        delete notificationClients[slug];
    }
}
/** Soft-delete: set deletedAt timestamp and remove from caches. */
export async function softDeleteClient(slug) {
    unregisterFromMemory(slug);
    await clients().updateOne({ _id: slug }, { $set: { deletedAt: new Date() } });
    console.log(`[client-store] soft-deleted client "${slug}"`);
}
/** Restore a soft-deleted client: unset deletedAt and reload into caches. */
export async function restoreClient(slug) {
    await clients().updateOne({ _id: slug }, { $unset: { deletedAt: "" } });
    const doc = await clients().findOne({ _id: slug });
    if (doc && typeof doc.agent_id === "string" && doc.agent_id) {
        registerInMemory(slug, toClientConfig(doc));
    }
    console.log(`[client-store] restored client "${slug}"`);
}
/** List soft-deleted clients. */
export async function listDeletedClients() {
    return clients()
        .find({ deletedAt: { $exists: true } }, {
        projection: { _id: 1, name: 1, deletedAt: 1 },
    })
        .toArray();
}
/** Permanently delete documents where deletedAt is older than `days` days. Also cleans up Retell. */
export async function purgeExpiredClients(days = 30) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const expired = await clients()
        .find({ deletedAt: { $lt: cutoff } })
        .toArray();
    if (expired.length === 0)
        return 0;
    // Lazy-import Retell + config to avoid circular deps at module load
    const [{ default: Retell }, { config }] = await Promise.all([
        import("retell-sdk"),
        import("../config.js"),
    ]);
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    for (const doc of expired) {
        const retellAgents = doc.retell_agents ?? {};
        for (const [agentId, agentJson] of Object.entries(retellAgents)) {
            try {
                await retell.agent.delete(agentId);
                console.log(`[purge] deleted Retell agent ${agentId}`);
            }
            catch (err) {
                console.warn(`[purge] could not delete Retell agent ${agentId}: ${err instanceof Error ? err.message : err}`);
            }
            const flowId = agentJson?.conversationFlow?.conversation_flow_id ??
                agentJson?.response_engine?.conversation_flow_id;
            if (flowId) {
                try {
                    await retell.conversationFlow.delete(flowId);
                    console.log(`[purge] deleted Retell flow ${flowId}`);
                }
                catch (err) {
                    console.warn(`[purge] could not delete Retell flow ${flowId}: ${err instanceof Error ? err.message : err}`);
                }
            }
        }
        // Belt-and-suspenders: also delete the agent_id if not in retell_agents map
        const fallbackAgentId = doc.agent_id;
        if (fallbackAgentId && !retellAgents[fallbackAgentId]) {
            try {
                await retell.agent.delete(fallbackAgentId);
                console.log(`[purge] deleted Retell agent ${fallbackAgentId} (from agent_id)`);
            }
            catch (err) {
                console.warn(`[purge] could not delete Retell agent ${fallbackAgentId}: ${err instanceof Error ? err.message : err}`);
            }
        }
    }
    const result = await clients().deleteMany({
        deletedAt: { $lt: cutoff },
    });
    console.log(`[client-store] purged ${result.deletedCount} expired soft-deleted client(s) + their Retell resources`);
    return result.deletedCount;
}
/** Permanently delete a client from MongoDB and remove from in-memory cache. */
export async function deleteClient(slug) {
    unregisterFromMemory(slug);
    await clients().deleteOne({ _id: slug });
    console.log(`[client-store] deleted client "${slug}"`);
}
/** Get full client document from MongoDB for detail view. */
export async function getClientDocument(slug) {
    return clients().findOne({ _id: slug });
}
/** Get all client documents from MongoDB (excludes soft-deleted). */
export async function getAllClientDocuments() {
    return clients().find({ deletedAt: { $exists: false } }).toArray();
}
/** Return lightweight summaries of all clients for the dashboard. */
export function getAllClientSummaries() {
    return Object.entries(notificationClients).map(([slug, c]) => ({
        slug,
        name: c.name,
        shadow_mode: c.shadow_mode ?? false,
        agent_id: c.agent_id,
    }));
}
/** Generate a portal token for a client and persist it. */
export async function generatePortalToken(slug) {
    const token = crypto.randomBytes(32).toString("hex");
    const result = await clients().updateOne({ _id: slug }, { $set: { portal_token: token } });
    if (result.matchedCount === 0) {
        throw new Error(`Client "${slug}" not found`);
    }
    console.log(`[client-store] generated portal token for "${slug}"`);
    return token;
}
/** Find all clients that have a given email in their dispatch_email array. */
export async function findClientsByEmail(email) {
    return clients()
        .find({ dispatch_email: email }, { projection: { _id: 1, name: 1, portal_token: 1 } })
        .toArray();
}
/** Validate a portal token against a client slug. */
export async function validatePortalToken(slug, token) {
    const doc = await clients().findOne({ _id: slug, portal_token: token }, { projection: { _id: 1 } });
    return doc !== null;
}
