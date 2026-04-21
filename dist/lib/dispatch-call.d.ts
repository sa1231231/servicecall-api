import type { ClientNotificationConfig } from "../config/notification-clients.js";
export declare function triggerDispatchCall(clientConfig: ClientNotificationConfig, dynamicVars: Record<string, string>): Promise<void>;
