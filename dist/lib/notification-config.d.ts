import type { JsonClientEntry } from "../config/client-store.js";
export interface VariableEntry {
    key: string;
    label: string;
}
export interface ClientInfo {
    slug: string;
    name?: string;
    dispatch_text_numbers: string[];
    dispatch_call_number?: string | null;
    dispatch_email?: string[] | null;
    dispatch_cc?: string | null;
    outbound_from_number?: string | null;
    summary_agent_id?: string | null;
    phone_fallback_to_caller?: boolean;
    hide_not_mentioned?: boolean;
    shadow_mode?: boolean;
}
export declare const LABEL_MAP: Record<string, string>;
export declare function toLabel(variableName: string, dataPointLabel?: string): string;
export declare function deriveNotificationConfig(variables: VariableEntry[], clientInfo: ClientInfo, agentId: string): JsonClientEntry;
