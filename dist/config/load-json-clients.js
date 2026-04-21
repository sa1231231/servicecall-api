import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { notificationClients, agentIdToClient, } from "./notification-clients.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, "notification-clients.json");
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
/** Load JSON client configs and merge into the in-memory maps. */
export function loadJsonClients() {
    if (!fs.existsSync(JSON_PATH))
        return;
    const raw = fs.readFileSync(JSON_PATH, "utf8");
    const entries = JSON.parse(raw);
    for (const [slug, entry] of Object.entries(entries)) {
        const config = toClientConfig(entry);
        notificationClients[slug] = config;
        for (const agentId of config.agent_ids) {
            agentIdToClient[agentId] = config;
        }
    }
    console.log(`[json-clients] loaded ${Object.keys(entries).length} client(s) from notification-clients.json`);
}
/** Persist a new client entry to the JSON file and register in memory. */
export function persistJsonClient(slug, entry) {
    // Read existing
    let entries = {};
    if (fs.existsSync(JSON_PATH)) {
        entries = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    }
    // Add new entry
    entries[slug] = entry;
    // Write back
    fs.writeFileSync(JSON_PATH, JSON.stringify(entries, null, 2), "utf8");
    // Register in memory
    const config = toClientConfig(entry);
    notificationClients[slug] = config;
    for (const agentId of config.agent_ids) {
        agentIdToClient[agentId] = config;
    }
    console.log(`[json-clients] persisted client "${slug}"`);
    return config;
}
export { JSON_PATH };
