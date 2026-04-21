import { type ClientNotificationConfig } from "../config/notification-clients.js";
export declare function sendOwnerCallMonitor(call: Record<string, any>, clientConfig: ClientNotificationConfig, notificationOutcome: string): Promise<void>;
