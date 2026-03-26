export interface Field {
    key: string;
    label: string;
}
export interface MessageType {
    label: string;
    subject_template: string;
    additional_text?: string;
    fields: Field[];
}
export interface ClientNotificationConfig {
    name: string;
    agent_ids: string[];
    dispatch_numbers: string[];
    dispatch_email: string | null;
    dispatch_cc: string | null;
    resolve_type: (vars: Record<string, string>) => string;
    message_types: Record<string, MessageType>;
    default_message_type: string;
    phone_fallback_to_caller?: boolean;
}
export declare const notificationClients: Record<string, ClientNotificationConfig>;
export declare const agentIdToClient: Record<string, ClientNotificationConfig>;
