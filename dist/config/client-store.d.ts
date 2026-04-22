import type { ClientNotificationConfig } from "./notification-clients.js";
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
    phone_fallback_to_caller?: boolean;
    hide_not_mentioned?: boolean;
    shadow_mode?: boolean;
    retell_agents?: Record<string, Record<string, unknown>>;
}
/** Load all clients from MongoDB and populate the in-memory maps. */
export declare function loadClientsFromDb(): Promise<void>;
/** Persist a client to MongoDB and register in memory. */
export declare function persistClient(slug: string, entry: JsonClientEntry): Promise<ClientNotificationConfig>;
/** Update a single field on a client in MongoDB and in memory. */
export declare function updateClientField(slug: string, field: string, value: unknown): Promise<void>;
/** Update multiple fields on a client in MongoDB and in memory. */
export declare function updateClientFields(slug: string, updates: Record<string, unknown>): Promise<void>;
/** Get full client document from MongoDB for detail view. */
export declare function getClientDocument(slug: string): Promise<(JsonClientEntry & {
    _id: string;
}) | null>;
/** Return lightweight summaries of all clients for the dashboard. */
export declare function getAllClientSummaries(): Array<{
    slug: string;
    name: string;
    shadow_mode: boolean;
    agent_ids: string[];
}>;
