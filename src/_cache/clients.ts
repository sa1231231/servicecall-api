// Runtime cache — rebuilt from MongoDB on every startup by client-store.ts.
// Do NOT treat as source of truth. MongoDB is the canonical store.

import type { ClientNotificationConfig } from "../config/notification-clients.js";

export const notificationClients: Record<string, ClientNotificationConfig> = {};
export const agentIdToClient: Record<string, ClientNotificationConfig> = {};
export const agentIdToSlug: Record<string, string> = {};
