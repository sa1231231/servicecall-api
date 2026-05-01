import type { ClientNotificationConfig } from "../config/notification-clients.js";
export declare const notificationClients: Record<string, ClientNotificationConfig>;
export declare const agentIdToClient: Record<string, ClientNotificationConfig>;
export declare const agentIdToSlug: Record<string, string>;
/** Maps a Retell phone number → { slug, client config }. Used by the pre-hook
 *  when inbound agent is unset on the number and agent_id is absent. */
export declare const phoneNumberToClient: Record<string, {
    slug: string;
    config: ClientNotificationConfig;
}>;
