import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import {
  getClientDocument,
  deleteClient,
} from "../../config/client-store.js";

export async function deleteAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = String(req.params.slug);

  const doc = await getClientDocument(slug);
  if (!doc) {
    res.status(404).json({ error: `Client "${slug}" not found` });
    return;
  }

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  const warnings: string[] = [];

  // Delete each Retell agent + its conversation flow (gracefully)
  const retellAgents = doc.retell_agents ?? {};
  for (const [agentId, agentJson] of Object.entries(retellAgents)) {
    // Try to delete the Retell agent
    try {
      await retell.agent.delete(agentId);
      console.log(`[delete-agent] deleted Retell agent ${agentId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[delete-agent] could not delete Retell agent ${agentId}: ${msg}`);
      warnings.push(`Retell agent ${agentId}: ${msg}`);
    }

    // Try to delete the conversation flow
    const flowId =
      (agentJson as Record<string, any>)?.conversationFlow?.conversation_flow_id ??
      (agentJson as Record<string, any>)?.response_engine?.conversation_flow_id;
    if (flowId) {
      try {
        await retell.conversationFlow.delete(flowId);
        console.log(`[delete-agent] deleted Retell flow ${flowId}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[delete-agent] could not delete Retell flow ${flowId}: ${msg}`);
        warnings.push(`Retell flow ${flowId}: ${msg}`);
      }
    }
  }

  // Also try to delete any agent_ids not in retell_agents (belt-and-suspenders)
  for (const agentId of doc.agent_ids ?? []) {
    if (retellAgents[agentId]) continue; // already handled above
    try {
      await retell.agent.delete(agentId);
      console.log(`[delete-agent] deleted Retell agent ${agentId} (from agent_ids)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[delete-agent] could not delete Retell agent ${agentId}: ${msg}`);
      warnings.push(`Retell agent ${agentId}: ${msg}`);
    }
  }

  // Delete from MongoDB + cache
  await deleteClient(slug);

  res.json({ success: true, slug, warnings: warnings.length > 0 ? warnings : undefined });
}
