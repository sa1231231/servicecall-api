import type { ClientNotificationConfig, MessageType } from "../config/notification-clients.js";
export interface NotificationPayload {
    typeKey: string;
    messageType: MessageType;
    fieldValues: Record<string, string>;
    visibleFields: Array<{
        label: string;
        value: string;
    }>;
    smsMessage: string;
    emailBody: string;
    emailHtml: string;
    emailSubject: string;
}
export type BuildResult = {
    ok: true;
    payload: NotificationPayload;
} | {
    ok: false;
    reason: "no_message_type" | "failed_required" | "empty_call";
    details: string;
};
export interface BuildNotificationInput {
    clientConfig: ClientNotificationConfig;
    allVars: Record<string, string>;
    callerNumber?: string;
}
export declare function buildNotificationMessages(input: BuildNotificationInput): BuildResult;
export declare function renderTemplate(template: string, values: Record<string, string>): string;
