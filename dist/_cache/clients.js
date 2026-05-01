// Runtime cache — rebuilt from MongoDB on every startup by client-store.ts.
// Do NOT treat as source of truth. MongoDB is the canonical store.
export const notificationClients = {};
export const agentIdToClient = {};
export const agentIdToSlug = {};
/** Maps a Retell phone number → { slug, client config }. Used by the pre-hook
 *  when inbound agent is unset on the number and agent_id is absent. */
export const phoneNumberToClient = {};
