import type { ClientNotificationConfig } from "../config/notification-clients.js";
export declare function resolveDispatch(clientConfig: ClientNotificationConfig, typeKey: string): {
    text_numbers: string[];
    email: string[] | null;
    cc: string | null;
    call_number: string | null;
};
