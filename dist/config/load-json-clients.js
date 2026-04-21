// ────────────────────────────────────────────────────────────────────────────
// DEPRECATED — This file is no longer in use.
// Client configs are now stored in MongoDB and managed by client-store.ts.
// Kept for reference only.
// ────────────────────────────────────────────────────────────────────────────
export {};
/*
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  notificationClients,
  agentIdToClient,
  type ClientNotificationConfig,
} from "./notification-clients.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, "notification-clients.json");

export interface ResolveRule {
  field: string;
  equals: string;
  then: string;
  else: string;
}

export interface JsonClientEntry {
  name: string;
  agent_ids: string[];
  dispatch_text_numbers: string[];
  dispatch_call_number: string | null;
  summary_agent_id: string | null;
  outbound_from_number: string | null;
  dispatch_email: string[] | null;
  dispatch_cc: string | null;
  resolve_rule?: ResolveRule;
  message_types: Record<
    string,
    {
      label: string;
      subject_template: string;
      additional_text?: string;
      fields: Array<{
        key: string;
        label: string;
        show?: boolean;
        required?: true | { equals: string | string[] };
        show_when?: { field: string; equals: string | string[] };
        format?: "yes_no";
      }>;
    }
  >;
  default_message_type: string;
  phone_fallback_to_caller?: boolean;
  hide_not_mentioned?: boolean;
  shadow_mode?: boolean;
}

function ruleToFunction(
  rule: ResolveRule | undefined,
  defaultType: string,
): (vars: Record<string, string>) => string {
  if (!rule) return () => defaultType;
  return (vars) =>
    vars[rule.field] === rule.equals ? rule.then : rule.else;
}

function toClientConfig(entry: JsonClientEntry): ClientNotificationConfig {
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

export function loadJsonClients(): void {
  if (!fs.existsSync(JSON_PATH)) return;

  const raw = fs.readFileSync(JSON_PATH, "utf8");
  const entries: Record<string, JsonClientEntry> = JSON.parse(raw);

  for (const [slug, entry] of Object.entries(entries)) {
    const config = toClientConfig(entry);
    notificationClients[slug] = config;
    for (const agentId of config.agent_ids) {
      agentIdToClient[agentId] = config;
    }
  }

  console.log(
    `[json-clients] loaded ${Object.keys(entries).length} client(s) from notification-clients.json`,
  );
}

export function persistJsonClient(
  slug: string,
  entry: JsonClientEntry,
): ClientNotificationConfig {
  let entries: Record<string, JsonClientEntry> = {};
  if (fs.existsSync(JSON_PATH)) {
    entries = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  }

  entries[slug] = entry;

  fs.writeFileSync(JSON_PATH, JSON.stringify(entries, null, 2), "utf8");

  const config = toClientConfig(entry);
  notificationClients[slug] = config;
  for (const agentId of config.agent_ids) {
    agentIdToClient[agentId] = config;
  }

  console.log(`[json-clients] persisted client "${slug}"`);
  return config;
}

export { JSON_PATH };
*/
