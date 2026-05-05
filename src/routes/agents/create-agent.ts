import type { Request, Response } from "express";
import {
  createAgentFromConfig,
  type CreateAgentBody,
} from "../../lib/agent-from-config.js";

export type { CreateAgentBody } from "../../lib/agent-from-config.js";

export async function createAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const result = await createAgentFromConfig(req.body as CreateAgentBody);

  if (result.ok) {
    res.status(201).json({
      success: true,
      agent_id: result.agentId,
      conversation_flow_id: result.conversationFlowId,
      slug: result.slug,
      notification_config: result.notificationConfig,
      provisioned_number: result.provisionedNumber,
      provision_error: result.provisionError,
    });
    return;
  }

  const body: { error: string; details?: string } = { error: result.error };
  if (result.details !== undefined) body.details = result.details;
  res.status(result.status).json(body);
}
