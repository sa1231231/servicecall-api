import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { notificationClients } from "../../_cache/clients.js";
import { persistClient, updateClientField } from "../../config/client-store.js";
import { provisionPhoneNumber } from "../../lib/provision-number.js";
import {
  generateAgent,
  type AgentConfig,
  type RawDataPoint,
  type DataPoint,
  type PathConfig,
} from "../../lib/agent-generator/index.js";
import type { HumanRequestMode } from "../../lib/agent-generator/node-builders.js";
import {
  toLabel,
  deriveNotificationConfig,
  deriveMultiPathNotificationConfig,
  type VariableEntry,
} from "../../lib/notification-config.js";
import {
  extractFlowParams,
  extractAgentParams,
} from "../../lib/retell-sync.js";

// ── DataPoint → VariableEntry flattening ─────────────────────────────────────

function flattenDataPoints(resolved: DataPoint[]): VariableEntry[] {
  const variables: VariableEntry[] = [];
  for (const dp of resolved) {
    if (dp.composite && dp.variables) {
      for (const v of dp.variables) {
        variables.push({ key: v.variableName, label: toLabel(v.variableName) });
      }
    } else {
      variables.push({ key: dp.variableName, label: toLabel(dp.variableName, dp.label) });
    }
  }
  return variables;
}

// ── Request Body Type ────────────────────────────────────────────────────────

interface CreateAgentBody {
  business: AgentConfig & { human_request_mode?: HumanRequestMode };
  dataPoints?: RawDataPoint[];
  paths?: Array<{
    name: string;
    transitionCondition: string;
    dataPoints: RawDataPoint[];
  }>;
  client: {
    slug: string;
    name?: string;
    dispatch_text_numbers: string[];
    dispatch_call_number?: string | null;
    dispatch_email?: string[] | null;
    dispatch_cc?: string | null;
    dispatch_by_type?: Record<string, {
      dispatch_text_numbers?: string[];
      dispatch_email?: string[];
      dispatch_cc?: string | null;
      dispatch_call_number?: string | null;
    }>;
    outbound_from_number?: string | null;
    summary_agent_id?: string | null;
    phone_fallback_to_caller?: boolean;
    hide_not_mentioned?: boolean;
    shadow_mode?: boolean;
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function createAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as CreateAgentBody;

  // ── Validate ───────────────────────────────────────────────────────────────
  if (!body.business?.businessName || !body.business?.faqKnowledgeBase) {
    res.status(400).json({ error: "Missing required field: business.businessName and business.faqKnowledgeBase" });
    return;
  }

  const hasPaths = Array.isArray(body.paths) && body.paths.length > 0;
  const hasDataPoints = Array.isArray(body.dataPoints) && body.dataPoints.length > 0;

  if (!hasPaths && !hasDataPoints) {
    res.status(400).json({ error: "Must provide either 'dataPoints' or 'paths' (non-empty)" });
    return;
  }

  if (hasPaths) {
    for (const [i, p] of body.paths!.entries()) {
      if (!p.name) {
        res.status(400).json({ error: `paths[${i}].name is required` });
        return;
      }
      if (!p.transitionCondition) {
        res.status(400).json({ error: `paths[${i}].transitionCondition is required` });
        return;
      }
      if (!Array.isArray(p.dataPoints) || p.dataPoints.length === 0) {
        res.status(400).json({ error: `paths[${i}].dataPoints must be non-empty` });
        return;
      }
    }
  }

  if (!body.client?.slug) {
    res.status(400).json({ error: "Missing required field: client.slug" });
    return;
  }
  if (!Array.isArray(body.client.dispatch_text_numbers) || body.client.dispatch_text_numbers.length === 0) {
    res.status(400).json({ error: "Missing required field: client.dispatch_text_numbers (non-empty array)" });
    return;
  }
  if (notificationClients[body.client.slug]) {
    res.status(409).json({ error: `Client slug "${body.client.slug}" already exists` });
    return;
  }

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  let conversationFlowId: string | undefined;

  try {
    // ── 1. Generate agent JSON ─────────────────────────────────────────────
    console.log(`[create-agent] generating agent for "${body.business.businessName}"`);
    const agentConfig: AgentConfig = {
      ...body.business,
      humanRequestMode: body.business.human_request_mode || "callback",
    };
    const { agent: agentJson, resolved, resolvedPaths } = generateAgent(
      agentConfig,
      body.dataPoints ?? [],
      body.paths as PathConfig[] | undefined,
    );

    const slug = body.client.slug;

    // ── 2. Create conversation flow in Retell ──────────────────────────────
    const conversationFlow = agentJson.conversationFlow as Record<string, unknown>;
    const flowParams = extractFlowParams(conversationFlow);

    console.log(`[create-agent] creating conversation flow in Retell...`);
    const flowResponse = await retell.conversationFlow.create(flowParams as any);
    conversationFlowId = flowResponse.conversation_flow_id;
    console.log(`[create-agent] conversation flow created: ${conversationFlowId}`);

    // ── 4. Create agent in Retell ──────────────────────────────────────────
    const agentParams = extractAgentParams(agentJson, conversationFlowId);

    console.log(`[create-agent] creating agent in Retell...`);
    const agentResponse = await retell.agent.create(agentParams as any);
    const agentId = agentResponse.agent_id;
    console.log(`[create-agent] agent created: ${agentId}`);

    // ── 5. Derive and persist notification config ──────────────────────────
    let jsonEntry;
    if (resolvedPaths && resolvedPaths.length > 1) {
      // Multi-path: one message_type per path
      const pathVariables = resolvedPaths.map((p) => ({
        name: p.name,
        variables: flattenDataPoints(p.resolved),
      }));
      jsonEntry = deriveMultiPathNotificationConfig(pathVariables, body.client, agentId);
    } else {
      // Single-path (backward compat)
      const variables = flattenDataPoints(resolved);
      jsonEntry = deriveNotificationConfig(variables, body.client, agentId);
    }

    // Store canonical agent JSON on the client document
    const canonicalJson = { ...agentJson, agent_id: agentId };
    jsonEntry.retell_agents = { [agentId]: canonicalJson };

    // Apply per-path dispatch overrides if provided
    if (body.client.dispatch_by_type) {
      jsonEntry.dispatch_by_type = body.client.dispatch_by_type;
    }

    await persistClient(slug, jsonEntry);

    console.log(`[create-agent] client "${slug}" registered with agent ${agentId}`);

    // ── 6. Provision phone number ──────────────────────────────────────────
    let provisionedNumber: string | null = null;
    let provisionError: string | null = null;

    const dispatchCall = body.client.dispatch_call_number;
    if (dispatchCall) {
      try {
        const result = await provisionPhoneNumber({
          agentId,
          clientName: body.business.businessName,
          dispatchCallNumber: dispatchCall,
        });
        provisionedNumber = result.phoneNumber;
        console.log(`[create-agent] provisioned number ${provisionedNumber} for "${slug}"`);
      } catch (provErr: unknown) {
        const msg = provErr instanceof Error ? provErr.message : String(provErr);
        provisionError = msg;
        console.error(`[create-agent] provisioning failed for "${slug}":`, msg);
      }
    }

    // ── 7. Return response ─────────────────────────────────────────────────
    res.status(201).json({
      success: true,
      agent_id: agentId,
      conversation_flow_id: conversationFlowId,
      notification_config: jsonEntry,
      provisioned_number: provisionedNumber,
      provision_error: provisionError,
    });
  } catch (err: unknown) {
    console.error("[create-agent] error:", err);

    // Cleanup: if we created a conversation flow but agent creation failed
    if (conversationFlowId) {
      try {
        console.log(`[create-agent] cleaning up conversation flow ${conversationFlowId}`);
        await retell.conversationFlow.delete(conversationFlowId);
      } catch (cleanupErr) {
        console.error("[create-agent] cleanup failed:", cleanupErr);
      }
    }

    const message =
      err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: "Failed to create agent in Retell", details: message });
  }
}
