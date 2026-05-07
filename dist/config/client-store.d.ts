import type { ClientNotificationConfig } from "./notification-clients.js";
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
    message_types: Record<string, {
        label: string;
        subject_template: string;
        additional_text?: string;
        fields: Array<{
            key: string;
            label: string;
            show?: boolean;
            required?: true | {
                equals: string | string[];
            };
            show_when?: {
                field: string;
                equals: string | string[];
            };
            format?: "yes_no";
        }>;
    }>;
    default_message_type: string;
    webhook_url?: string;
    notification_greeting?: string;
    weekly_report_enabled?: boolean;
    trial_start_date?: string;
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
    folder_id?: string | null;
}
export declare function ruleToFunction(rule: ResolveRule | undefined, rules: ResolveRuleEntry[] | undefined, defaultType: string): (vars: Record<string, string>) => string;
export declare function toClientConfig(entry: JsonClientEntry): ClientNotificationConfig;
/** Load all clients from MongoDB and populate the in-memory maps. */
export declare function loadClientsFromDb(): Promise<void>;
/** Persist a client to MongoDB and register in memory. */
export declare function persistClient(slug: string, entry: JsonClientEntry): Promise<ClientNotificationConfig>;
/** Update a single field on a client in MongoDB and in memory. */
export declare function updateClientField(slug: string, field: string, value: unknown): Promise<void>;
/** Update multiple fields on a client in MongoDB and in memory. */
export declare function updateClientFields(slug: string, updates: Record<string, unknown>): Promise<void>;
/** Soft-delete: set deletedAt timestamp and remove from caches. */
export declare function softDeleteClient(slug: string): Promise<void>;
/** Restore a soft-deleted client: unset deletedAt and reload into caches. */
export declare function restoreClient(slug: string): Promise<void>;
/** List soft-deleted clients. */
export declare function listDeletedClients(): Promise<Array<{
    _id: string;
    name: string;
    deletedAt: Date;
}>>;
/**
 * Permanently delete documents where deletedAt is older than `days` days.
 * Also releases Retell + Twilio resources via the shared
 * releaseAgentResources helper — same code path as the manual hard-delete
 * handler, so TTL-expired clients get the same Twilio number release (and
 * therefore the same charge cutoff) as a manually-purged one.
 */
export declare function purgeExpiredClients(days?: number): Promise<number>;
/** Permanently delete a client from MongoDB and remove from in-memory cache. */
export declare function deleteClient(slug: string): Promise<void>;
/** Get full client document from MongoDB for detail view. */
export declare function getClientDocument(slug: string): Promise<(JsonClientEntry & {
    _id: string;
}) | null>;
/** Get all client documents from MongoDB (excludes soft-deleted). */
export declare function getAllClientDocuments(): Promise<Array<JsonClientEntry & {
    _id: string;
}>>;
/** Return lightweight summaries of all clients for the dashboard. */
export declare function getAllClientSummaries(): Array<{
    slug: string;
    name: string;
    shadow_mode: boolean;
    agent_id: string;
}>;
/** Generate a portal token for a client and persist it. */
export declare function generatePortalToken(slug: string): Promise<string>;
/** Find all clients that have a given email in their dispatch_email array. */
export declare function findClientsByEmail(email: string): Promise<Array<{
    _id: string;
    name: string;
    portal_token: string | null;
}>>;
/** Validate a portal token against a client slug. */
export declare function validatePortalToken(slug: string, token: string): Promise<boolean>;
