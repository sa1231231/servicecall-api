import crypto from "crypto";
import { getDb } from "../lib/db.js";
import type { ClientNotificationConfig } from "./notification-clients.js";
import {
  notificationClients,
  agentIdToClient,
  agentIdToSlug,
} from "../_cache/clients.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResolveRule {
  field: string;
  equals: string;
  then: string;
  else: string;
}

export interface ResolveRuleEntry {
  field: string;
  equals: string;
  then: string;
}

export interface JsonClientEntry {
  name: string;
  agent_ids: string[];
  dispatch_text_numbers: string[];
  dispatch_call_number: string | null;
  dispatch_call_overrides?: Record<string, string>;
  dispatch_by_type?: Record<string, {
    dispatch_text_numbers?: string[];
    dispatch_email?: string[];
    dispatch_cc?: string | null;
    dispatch_call_number?: string | null;
  }>;
  summary_agent_id: string | null;
  outbound_from_number: string | null;
  dispatch_email: string[] | null;
  dispatch_cc: string | null;
  resolve_rule?: ResolveRule;
  resolve_rules?: ResolveRuleEntry[];
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
  webhook_url?: string;
  notification_greeting?: string;
  weekly_report_enabled?: boolean;
  phone_fallback_to_caller?: boolean;
  hide_not_mentioned?: boolean;
  shadow_mode?: boolean;
  retell_agents?: Record<string, Record<string, unknown>>;
  last_deployed_at?: string;
  portal_token?: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function ruleToFunction(
  rule: ResolveRule | undefined,
  rules: ResolveRuleEntry[] | undefined,
  defaultType: string,
): (vars: Record<string, string>) => string {
  // Multi-path: ordered rules, first match wins
  if (rules && rules.length > 0) {
    return (vars) => {
      for (const r of rules) {
        if (vars[r.field] === r.equals) return r.then;
      }
      return defaultType;
    };
  }
  // Single binary rule (backward compat)
  if (rule) {
    return (vars) =>
      vars[rule.field] === rule.equals ? rule.then : rule.else;
  }
  return () => defaultType;
}

export function toClientConfig(entry: JsonClientEntry): ClientNotificationConfig {
  return {
    name: entry.name,
    agent_ids: entry.agent_ids,
    dispatch_text_numbers: entry.dispatch_text_numbers,
    dispatch_call_number: entry.dispatch_call_number,
    dispatch_call_overrides: entry.dispatch_call_overrides,
    dispatch_by_type: entry.dispatch_by_type,
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
  };
}

function registerInMemory(slug: string, config: ClientNotificationConfig): void {
  notificationClients[slug] = config;
  for (const agentId of config.agent_ids) {
    agentIdToClient[agentId] = config;
    agentIdToSlug[agentId] = slug;
  }
}

// ── Collection accessor ──────────────────────────────────────────────────────

function clients() {
  return getDb().collection<JsonClientEntry & { _id: string }>("clients");
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load all clients from MongoDB and populate the in-memory maps. */
export async function loadClientsFromDb(): Promise<void> {
  const docs = await clients().find().toArray();

  for (const doc of docs) {
    const slug = doc._id;
    if (!Array.isArray(doc.agent_ids)) {
      console.log(`[client-store] skipping "${slug}" (missing agent_ids)`);
      continue;
    }
    const config = toClientConfig(doc);
    registerInMemory(slug, config);
  }

  console.log(`[client-store] loaded ${docs.length} client(s) from MongoDB`);
}

/** Persist a client to MongoDB and register in memory. */
export async function persistClient(
  slug: string,
  entry: JsonClientEntry,
): Promise<ClientNotificationConfig> {
  entry.last_deployed_at = new Date().toISOString();
  await clients().replaceOne(
    { _id: slug } as any,
    { _id: slug, ...entry } as any,
    { upsert: true },
  );

  const config = toClientConfig(entry);
  registerInMemory(slug, config);

  console.log(`[client-store] persisted client "${slug}"`);
  return config;
}

/** Update a single field on a client in MongoDB and in memory. */
export async function updateClientField(
  slug: string,
  field: string,
  value: unknown,
): Promise<void> {
  const result = await clients().updateOne(
    { _id: slug } as any,
    { $set: { [field]: value } },
  );

  if (result.matchedCount === 0) {
    throw new Error(`Client "${slug}" not found`);
  }

  // Update in-memory config
  const existing = notificationClients[slug];
  if (existing) {
    (existing as any)[field] = value;
  }

  console.log(`[client-store] updated "${slug}".${field} = ${JSON.stringify(value)}`);
}

const EDITABLE_FIELDS = new Set([
  "name",
  "agent_ids",
  "dispatch_text_numbers",
  "dispatch_call_number",
  "dispatch_call_overrides",
  "dispatch_by_type",
  "dispatch_email",
  "dispatch_cc",
  "outbound_from_number",
  "summary_agent_id",
  "shadow_mode",
  "hide_not_mentioned",
  "notification_greeting",
  "webhook_url",
  "weekly_report_enabled",
  "message_types",
  "resolve_rules",
]);

/** Update multiple fields on a client in MongoDB and in memory. */
export async function updateClientFields(
  slug: string,
  updates: Record<string, unknown>,
): Promise<void> {
  // Whitelist validation
  const setObj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE_FIELDS.has(key)) {
      throw new Error(`Field "${key}" is not editable`);
    }
    setObj[key] = value;
  }

  if (Object.keys(setObj).length === 0) {
    throw new Error("No valid fields to update");
  }

  const result = await clients().updateOne(
    { _id: slug } as any,
    { $set: setObj },
  );

  if (result.matchedCount === 0) {
    throw new Error(`Client "${slug}" not found`);
  }

  // Update in-memory config
  const existing = notificationClients[slug];
  if (existing) {
    // Special handling for agent_ids: remove old mappings first
    if ("agent_ids" in setObj) {
      for (const oldId of existing.agent_ids) {
        delete agentIdToClient[oldId];
        delete agentIdToSlug[oldId];
      }
    }

    // Apply all field updates to in-memory object
    for (const [key, value] of Object.entries(setObj)) {
      (existing as any)[key] = value;
    }

    // Re-register agent_ids if they changed
    if ("agent_ids" in setObj) {
      for (const newId of existing.agent_ids) {
        agentIdToClient[newId] = existing;
        agentIdToSlug[newId] = slug;
      }
    }
  }

  console.log(`[client-store] updated "${slug}" fields: ${Object.keys(setObj).join(", ")}`);
}

/** Delete a client from MongoDB and remove from in-memory cache. */
export async function deleteClient(slug: string): Promise<void> {
  const existing = notificationClients[slug];
  if (existing) {
    for (const agentId of existing.agent_ids) {
      delete agentIdToClient[agentId];
      delete agentIdToSlug[agentId];
    }
    delete notificationClients[slug];
  }

  await clients().deleteOne({ _id: slug } as any);
  console.log(`[client-store] deleted client "${slug}"`);
}

/** Get full client document from MongoDB for detail view. */
export async function getClientDocument(
  slug: string,
): Promise<(JsonClientEntry & { _id: string }) | null> {
  return clients().findOne({ _id: slug } as any) as any;
}

/** Get all client documents from MongoDB. */
export async function getAllClientDocuments(): Promise<
  Array<JsonClientEntry & { _id: string }>
> {
  return clients().find().toArray() as any;
}

/** Return lightweight summaries of all clients for the dashboard. */
export function getAllClientSummaries(): Array<{
  slug: string;
  name: string;
  shadow_mode: boolean;
  agent_ids: string[];
}> {
  return Object.entries(notificationClients).map(([slug, c]) => ({
    slug,
    name: c.name,
    shadow_mode: c.shadow_mode ?? false,
    agent_ids: c.agent_ids,
  }));
}

/** Generate a portal token for a client and persist it. */
export async function generatePortalToken(slug: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const result = await clients().updateOne(
    { _id: slug } as any,
    { $set: { portal_token: token } },
  );
  if (result.matchedCount === 0) {
    throw new Error(`Client "${slug}" not found`);
  }
  console.log(`[client-store] generated portal token for "${slug}"`);
  return token;
}

/** Validate a portal token against a client slug. */
export async function validatePortalToken(
  slug: string,
  token: string,
): Promise<boolean> {
  const doc = await clients().findOne(
    { _id: slug, portal_token: token } as any,
    { projection: { _id: 1 } },
  );
  return doc !== null;
}
