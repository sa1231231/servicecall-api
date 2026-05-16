import crypto from "crypto";
import { getDb } from "../lib/db.js";
import type { ClientNotificationConfig } from "./notification-clients.js";
import {
  notificationClients,
  agentIdToClient,
  agentIdToSlug,
  phoneNumberToClient,
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
  // Optional dashboard-only label. Drives the agent dashboard list/detail
  // header, the Retell console agent_name, and Retell phone-number nicknames.
  // Does NOT propagate into prompts, conversation flow text, FAQ, or
  // post-hook templates — those continue to use `name`. Falls back to `name`
  // when unset.
  display_name?: string | null;
  agent_id: string;
  dispatch_text_numbers: string[];
  dispatch_call_number: string | null;
  dispatch_call_overrides?: Record<string, string>;
  dispatch_by_type?: Record<string, {
    dispatch_text_numbers?: string[];
    dispatch_email?: string[];
    dispatch_cc?: string | null;
    dispatch_call_number?: string | null;
  }>;
  path_end_modes?: Record<string, "callback" | "transfer">;
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
  trial_start_date?: string;
  // Admin-only client contact info shown in the Billing tab. Reference data
  // for the operator; not used by any agent or notification logic.
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  contact_timezone?: string | null;
  contact_notes?: string | null;
  phone_fallback_to_caller?: boolean;
  hide_not_mentioned?: boolean;
  shadow_mode?: boolean;
  active?: boolean;
  retell_agents?: Record<string, Record<string, unknown>>;
  last_deployed_at?: string;
  portal_token?: string | null;
  // ID of the agent_folders document this client belongs to. Null/missing
  // means the client lives in the "Unfiled" pseudo-folder on the dashboard.
  folder_id?: string | null;
  // Per-client opt-in: when true, every completed call enqueues an
  // Anthropic-driven transcript review that surfaces approval-gated
  // suggestions in the dashboard. The from-draft route defaults this on for
  // every draft-sourced agent; standalone agents are off unless set.
  transcript_review_enabled?: boolean;
  // Name of the draft this agent was created from (via /agents/from-draft).
  // Used by the transcript-review system to scope suggestions back to a
  // shared draft — when set, an approval can propagate to the draft and its
  // sibling agents (Phase 3).
  source_draft?: string;
  // Soft-delete timestamp set by listAllClients's deletion path. Absence
  // means the client is live; presence means it's been soft-deleted and
  // is eligible for restore until the eventual hard-delete sweep.
  deletedAt?: Date;
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

function registerInMemory(slug: string, config: ClientNotificationConfig): void {
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
  return getDb().collection<JsonClientEntry & { _id: string }>("clients");
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load all clients from MongoDB and populate the in-memory maps. */
export async function loadClientsFromDb(): Promise<void> {
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
  "transcript_review_enabled",
  "source_draft",
]);

/** Thrown when an `expectedVersion` guard fails (someone else wrote first). */
export class ConcurrencyError extends Error {
  readonly code = "CONCURRENCY_CONFLICT";
  constructor(slug: string, expected: number) {
    super(`Client "${slug}" was modified by another request (expected version ${expected})`);
    this.name = "ConcurrencyError";
  }
}

/** Update multiple fields on a client in MongoDB and in memory.
 *
 * Pass `opts.expectedVersion` to enable optimistic concurrency: the write
 * only succeeds if `_version` still matches. On mismatch, throws
 * `ConcurrencyError` so the route can surface a 409 to the caller.
 *
 * Every successful write increments `_version` by 1. */
export async function updateClientFields(
  slug: string,
  updates: Record<string, unknown>,
  opts: { expectedVersion?: number } = {},
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

  const filter: Record<string, unknown> = { _id: slug };
  if (typeof opts.expectedVersion === "number") {
    filter._version = opts.expectedVersion;
  }

  const result = await clients().updateOne(
    filter as any,
    { $set: setObj, $inc: { _version: 1 } },
  );

  if (result.matchedCount === 0) {
    if (typeof opts.expectedVersion === "number") {
      const exists = await clients().findOne({ _id: slug } as any);
      if (exists) throw new ConcurrencyError(slug, opts.expectedVersion);
    }
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
      (existing as any)[key] = value;
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
function unregisterFromMemory(slug: string): void {
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
export async function softDeleteClient(slug: string): Promise<void> {
  unregisterFromMemory(slug);
  await clients().updateOne(
    { _id: slug } as any,
    { $set: { deletedAt: new Date() } },
  );
  console.log(`[client-store] soft-deleted client "${slug}"`);
}

/** Restore a soft-deleted client: unset deletedAt and reload into caches. */
export async function restoreClient(slug: string): Promise<void> {
  await clients().updateOne(
    { _id: slug } as any,
    { $unset: { deletedAt: "" } },
  );
  const doc = await clients().findOne({ _id: slug } as any);
  if (doc && typeof doc.agent_id === "string" && doc.agent_id) {
    registerInMemory(slug, toClientConfig(doc));
  }
  console.log(`[client-store] restored client "${slug}"`);
}

/** List soft-deleted clients. */
export async function listDeletedClients(): Promise<
  Array<{ _id: string; name: string; deletedAt: Date }>
> {
  return clients()
    .find({ deletedAt: { $exists: true } } as any, {
      projection: { _id: 1, name: 1, deletedAt: 1 },
    })
    .toArray() as any;
}

/**
 * Permanently delete documents where deletedAt is older than `days` days.
 * Also releases Retell + Twilio resources via the shared
 * releaseAgentResources helper — same code path as the manual hard-delete
 * handler, so TTL-expired clients get the same Twilio number release (and
 * therefore the same charge cutoff) as a manually-purged one.
 */
export async function purgeExpiredClients(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const expired = await clients()
    .find({ deletedAt: { $lt: cutoff } } as any)
    .toArray();

  if (expired.length === 0) return 0;

  // Lazy-import to avoid circular deps at module load.
  const { releaseAgentResources } = await import("../lib/release-agent-resources.js");

  for (const doc of expired) {
    await releaseAgentResources(
      (doc as any)._id,
      doc as { agent_id?: string | null; retell_agents?: Record<string, unknown> | null },
      "purge",
    );
  }

  const result = await clients().deleteMany({
    deletedAt: { $lt: cutoff },
  } as any);
  console.log(`[client-store] purged ${result.deletedCount} expired soft-deleted client(s) + their external resources`);
  return result.deletedCount;
}

/** Permanently delete a client from MongoDB and remove from in-memory cache. */
export async function deleteClient(slug: string): Promise<void> {
  unregisterFromMemory(slug);
  await clients().deleteOne({ _id: slug } as any);
  console.log(`[client-store] deleted client "${slug}"`);
}

/** Get full client document from MongoDB for detail view. */
export async function getClientDocument(
  slug: string,
): Promise<(JsonClientEntry & { _id: string }) | null> {
  return clients().findOne({ _id: slug } as any) as any;
}

/** Get all client documents from MongoDB (excludes soft-deleted). */
export async function getAllClientDocuments(): Promise<
  Array<JsonClientEntry & { _id: string }>
> {
  return clients().find({ deletedAt: { $exists: false } }).toArray() as any;
}

/** Return lightweight summaries of all clients for the dashboard. */
export function getAllClientSummaries(): Array<{
  slug: string;
  name: string;
  shadow_mode: boolean;
  agent_id: string;
}> {
  return Object.entries(notificationClients).map(([slug, c]) => ({
    slug,
    name: c.name,
    shadow_mode: c.shadow_mode ?? false,
    agent_id: c.agent_id,
  }));
}

/** Portal tokens expire 90 days after issue. Operators can regenerate
 *  on demand via the dashboard's portal-token endpoint. */
export const PORTAL_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Generate a portal token for a client and persist it (with issue + expiry). */
export async function generatePortalToken(slug: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const result = await clients().updateOne(
    { _id: slug } as any,
    {
      $set: {
        portal_token: token,
        portal_token_issued_at: now,
        portal_token_expires_at: now + PORTAL_TOKEN_TTL_MS,
      },
    },
  );
  if (result.matchedCount === 0) {
    throw new Error(`Client "${slug}" not found`);
  }
  console.log(`[client-store] generated portal token for "${slug}" (expires ${new Date(now + PORTAL_TOKEN_TTL_MS).toISOString()})`);
  return token;
}

/** Find all clients that have a given email in their dispatch_email array. */
export async function findClientsByEmail(
  email: string,
): Promise<Array<{ _id: string; name: string; portal_token: string | null }>> {
  return clients()
    .find(
      { dispatch_email: email } as any,
      { projection: { _id: 1, name: 1, portal_token: 1 } },
    )
    .toArray() as any;
}

/** Validate a portal token against a client slug. Rejects expired tokens
 *  even if they match — operator must regenerate from the dashboard.
 *  Tokens minted before the TTL feature shipped have no
 *  `portal_token_expires_at` field; we treat those as legacy and accept
 *  them indefinitely until the next regeneration migrates them. */
export async function validatePortalToken(
  slug: string,
  token: string,
): Promise<boolean> {
  const doc = await clients().findOne(
    { _id: slug, portal_token: token } as any,
    { projection: { _id: 1, portal_token_expires_at: 1 } },
  );
  if (!doc) return false;
  const expiresAt = (doc as any).portal_token_expires_at as number | undefined;
  if (typeof expiresAt === "number" && Date.now() > expiresAt) return false;
  return true;
}
