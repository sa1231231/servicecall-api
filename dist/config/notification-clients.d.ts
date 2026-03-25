export interface MessageType {
    label: string;
    subject_template: string;
    additional_text?: string;
}
export interface Field {
    key: string;
    label: string;
}
export interface ClientNotificationConfig {
    client_id: string;
    name: string;
    dispatch_numbers: string[];
    dispatch_email: string | null;
    dispatch_cc: string | null;
    resolve_type: (vars: Record<string, string>) => string;
    message_types: Record<string, MessageType>;
    default_message_type: string;
    fields: Field[];
    phone_fallback_to_caller?: boolean;
}
export declare const notificationClients: Record<string, ClientNotificationConfig>;
