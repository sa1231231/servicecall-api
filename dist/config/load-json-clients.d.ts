import { type ClientNotificationConfig } from "./notification-clients.js";
declare const JSON_PATH: string;
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
}
/** Load JSON client configs and merge into the in-memory maps. */
export declare function loadJsonClients(): void;
/** Persist a new client entry to the JSON file and register in memory. */
export declare function persistJsonClient(slug: string, entry: JsonClientEntry): ClientNotificationConfig;
export { JSON_PATH };
