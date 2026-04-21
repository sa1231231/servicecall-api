import { getDb } from "../lib/db.js";
import { notificationClients, agentIdToClient, } from "./notification-clients.js";
// ── Helpers ──────────────────────────────────────────────────────────────────
function ruleToFunction(rule, defaultType) {
    if (!rule)
        return () => defaultType;
    return (vars) => vars[rule.field] === rule.equals ? rule.then : rule.else;
}
function toClientConfig(entry) {
    return {
        name: entry.name,
        agent_ids: entry.agent_ids,
        dispatch_text_numbers: entry.dispatch_text_numbers,
        dispatch_call_number: entry.dispatch_call_number,
        summary_agent_id: entry.summary_agent_id,
        outbound_from_number: entry.outbound_from_number,
        dispatch_email: entry.dispatch_email,
        dispatch_cc: entry.dispatch_cc,
        resolve_type: ruleToFunction(entry.resolve_rule, entry.default_message_type),
        message_types: entry.message_types,
        default_message_type: entry.default_message_type,
        phone_fallback_to_caller: entry.phone_fallback_to_caller,
        hide_not_mentioned: entry.hide_not_mentioned,
        shadow_mode: entry.shadow_mode,
    };
}
function registerInMemory(slug, config) {
    notificationClients[slug] = config;
    for (const agentId of config.agent_ids) {
        agentIdToClient[agentId] = config;
    }
}
// ── Collection accessor ──────────────────────────────────────────────────────
function clients() {
    return getDb().collection("clients");
}
// ── Public API ───────────────────────────────────────────────────────────────
/** Load all clients from MongoDB and populate the in-memory maps. */
export async function loadClientsFromDb() {
    const docs = await clients().find().toArray();
    for (const doc of docs) {
        const slug = doc._id;
        const config = toClientConfig(doc);
        registerInMemory(slug, config);
    }
    console.log(`[client-store] loaded ${docs.length} client(s) from MongoDB`);
}
/** Persist a client to MongoDB and register in memory. */
export async function persistClient(slug, entry) {
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
/** Return lightweight summaries of all clients for the dashboard. */
export function getAllClientSummaries() {
    return Object.entries(notificationClients).map(([slug, c]) => ({
        slug,
        name: c.name,
        shadow_mode: c.shadow_mode ?? false,
        agent_ids: c.agent_ids,
    }));
}
