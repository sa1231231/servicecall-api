// Runtime cache — rebuilt from MongoDB on every startup by client-store.ts.
// Do NOT treat as source of truth. MongoDB is the canonical store.

import type { ClientNotificationConfig } from "../config/notification-clients.js";

export const notificationClients: Record<string, ClientNotificationConfig> = {};
export const agentIdToClient: Record<string, ClientNotificationConfig> = {};
export const agentIdToSlug: Record<string, string> = {};
/** Maps a Retell phone number → { slug, client config }. Used by the pre-hook
 *  when inbound agent is unset on the number and agent_id is absent. */
export const phoneNumberToClient: Record<string, { slug: string; config: ClientNotificationConfig }> = {};
