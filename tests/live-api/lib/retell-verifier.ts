import Retell from "retell-sdk";
import { getLiveEnv } from "./env.js";

// Direct Retell API verifiers. Used to confirm that the dashboard
// API's create/delete operations actually propagated to Retell —
// not just to MongoDB.

let _client: Retell | null = null;
function client() {
  if (_client) return _client;
  _client = new Retell({ apiKey: getLiveEnv().retellApiKey });
  return _client;
}

export async function getAgent(agentId: string): Promise<unknown | null> {
  try {
    return await client().agent.retrieve(agentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404") || msg.toLowerCase().includes("not found")) return null;
    throw err;
  }
}

export async function assertAgentExists(agentId: string): Promise<void> {
  const a = await getAgent(agentId);
  if (!a) throw new Error(`Retell agent ${agentId} does not exist (expected to)`);
}

export async function assertAgentDeleted(agentId: string): Promise<void> {
  const a = await getAgent(agentId);
  if (a) throw new Error(`Retell agent ${agentId} still exists (expected deleted)`);
}

/** Returns true if any Retell phone number has the given agent_id bound
 *  (inbound or outbound). Used to verify number unbinding after delete. */
export async function isAgentBoundToAnyNumber(agentId: string): Promise<boolean> {
  const numbers = await client().phoneNumber.list();
  return numbers.some((n) =>
    (n.inbound_agents ?? []).some((a: { agent_id?: string }) => a.agent_id === agentId) ||
    n.outbound_agent_id === agentId,
  );
}

export async function assertAgentUnbound(agentId: string): Promise<void> {
  if (await isAgentBoundToAnyNumber(agentId)) {
    throw new Error(`Retell agent ${agentId} is still bound to a phone number (expected unbound)`);
  }
}

/** List all Retell agents with names that start with `prefix`. Used by
 *  the cleanup sweeper. */
export async function listAgentsWithNamePrefix(prefix: string): Promise<Array<{ agent_id: string; agent_name: string }>> {
  const all = await client().agent.list();
  return all
    .filter((a) => (a.agent_name ?? "").startsWith(prefix))
    .map((a) => ({ agent_id: a.agent_id, agent_name: a.agent_name ?? "" }));
}

/** Delete a Retell agent + its conversation flow if it has one.
 *  Best-effort — caller should swallow errors. */
export async function deleteAgent(agentId: string): Promise<void> {
  // Fetch first so we know the flow id (conversation_flow_id).
  const agent = await getAgent(agentId) as { response_engine?: { conversation_flow_id?: string } } | null;
  await client().agent.delete(agentId);
  const flowId = agent?.response_engine?.conversation_flow_id;
  if (flowId) {
    try { await client().conversationFlow.delete(flowId); } catch { /* best-effort */ }
  }
}
