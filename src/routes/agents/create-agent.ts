import type { Request, Response } from "express";
import Retell from "retell-sdk";
import { config } from "../../config.js";
import { notificationClients } from "../../_cache/clients.js";
import { persistClient, updateClientField } from "../../config/client-store.js";
import { provisionPhoneNumber } from "../../lib/provision-number.js";
import { getDataPointDefaults } from "../../lib/data-point-defaults.js";
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
    end_mode?: "callback" | "transfer";
  }>;
  client: {
    slug: string;
    name?: string;
    dispatch_text_numbers: string[];
    dispatch_call_number?: string | null;
    dispatch_call_overrides?: Record<string, string>;
    dispatch_email?: string[] | null;
    dispatch_cc?: string | null;
    dispatch_by_type?: Record<string, {
      dispatch_text_numbers?: string[];
      dispatch_email?: string[];
      dispatch_cc?: string | null;
      dispatch_call_number?: string | null;
    }>;
    path_end_modes?: Record<string, "callback" | "transfer">;
    outbound_from_number?: string | null;
    summary_agent_id?: string | null;
    webhook_url?: string;
    notification_greeting?: string;
    weekly_report_enabled?: boolean;
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
      if (p.end_mode && p.end_mode !== "callback" && p.end_mode !== "transfer") {
        res.status(400).json({ error: `paths[${i}].end_mode must be "callback" or "transfer"` });
        return;
      }
      if (p.end_mode === "transfer") {
        const perPath = body.client?.dispatch_by_type?.[p.name]?.dispatch_call_number;
        const fallback = body.client?.dispatch_call_number;
        if (!perPath && !fallback) {
          res.status(400).json({
            error: `paths[${i}] ("${p.name}") end_mode is "transfer" but no dispatch call number is set (per-path or client default)`,
          });
          return;
        }
      }
    }
  }

  if (!body.client?.slug) {
    res.status(400).json({ error: "Missing required field: client.slug" });
    return;
  }
  // Fall back to owner phone if dispatch_text_numbers is empty
  if (!Array.isArray(body.client.dispatch_text_numbers) || body.client.dispatch_text_numbers.length === 0) {
    const { getSettings } = await import("../../lib/settings.js");
    const settings = await getSettings();
    if (settings.owner_phone) {
      body.client.dispatch_text_numbers = [settings.owner_phone];
    } else {
      res.status(400).json({ error: "Missing dispatch_text_numbers and no owner phone configured in settings" });
      return;
    }
  }
  if (notificationClients[body.client.slug]) {
    res.status(409).json({ error: `Client slug "${body.client.slug}" already exists` });
    return;
  }

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  let conversationFlowId: string | undefined;

  try {
    // ── 1. Generate agent JSON ─────────────────────────────────────────────
    const pathSummary = hasPaths
      ? `${body.paths!.length} path(s): ${body.paths!.map(p => `"${p.name}" (${p.dataPoints.length} dps)`).join(", ")}`
      : `${body.dataPoints!.length} data points (flat)`;
    console.log(`[create-agent] generating agent for "${body.business.businessName}" — ${pathSummary}`);
    const agentConfig: AgentConfig = {
      ...body.business,
      humanRequestMode: body.business.human_request_mode || "callback",
      closePrompt: body.business.closePrompt?.trim() || undefined,
      closingRemarksPrompt: body.business.closingRemarksPrompt?.trim() || undefined,
      closingStatementText: body.business.closingStatementText?.trim() || undefined,
      liveTransferRecoveryPrompt: body.business.liveTransferRecoveryPrompt?.trim() || undefined,
    };
    const dpDefaults = await getDataPointDefaults();
    // Resolve per-path transfer destination from dispatch_by_type → client default.
    const pathConfigs: PathConfig[] | undefined = hasPaths
      ? body.paths!.map((p) => {
          const endMode: "callback" | "transfer" =
            p.end_mode === "transfer" ? "transfer" : "callback";
          const transferDestination =
            endMode === "transfer"
              ? body.client?.dispatch_by_type?.[p.name]?.dispatch_call_number ||
                body.client?.dispatch_call_number ||
                undefined
              : undefined;
          return {
            name: p.name,
            transitionCondition: p.transitionCondition,
            dataPoints: p.dataPoints,
            endMode,
            transferDestination: transferDestination ?? undefined,
          };
        })
      : undefined;
    const { agent: agentJson, resolved, resolvedPaths } = generateAgent(
      agentConfig,
      body.dataPoints ?? [],
      pathConfigs,
      dpDefaults,
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

    // Apply per-path end modes (callback/transfer). Only persist non-default entries.
    if (hasPaths) {
      const endModes: Record<string, "callback" | "transfer"> = {};
      for (const p of body.paths!) {
        if (p.end_mode === "transfer") endModes[p.name] = "transfer";
      }
      if (Object.keys(endModes).length > 0) {
        jsonEntry.path_end_modes = endModes;
      }
    }

    // Carry over additional client fields that the export endpoint emits
    // but `deriveNotificationConfig` doesn't read. These let a JSON
    // import round-trip a full client config (used for backup → restore
    // and template-based bootstrap of new agents).
    if (body.client.dispatch_call_overrides) {
      jsonEntry.dispatch_call_overrides = body.client.dispatch_call_overrides;
    }
    if (body.client.webhook_url) {
      jsonEntry.webhook_url = body.client.webhook_url;
    }
    if (body.client.notification_greeting) {
      jsonEntry.notification_greeting = body.client.notification_greeting;
    }
    if (typeof body.client.weekly_report_enabled === "boolean") {
      jsonEntry.weekly_report_enabled = body.client.weekly_report_enabled;
    }

    await persistClient(slug, jsonEntry);

    console.log(`[create-agent] client "${slug}" registered with agent ${agentId}`);

    // ── 6. Provision phone number ──────────────────────────────────────────
    let provisionedNumber: string | null = null;
    let provisionError: string | null = null;

    // Derive area code: client-level dispatch call > per-path override > default (815)
    const dispatchCall = body.client.dispatch_call_number
      || (body.client.dispatch_by_type
        ? Object.values(body.client.dispatch_by_type).find(o => o.dispatch_call_number)?.dispatch_call_number
        : null)
      || undefined;

    try {
      const result = await provisionPhoneNumber({
        agentId,
        clientName: body.business.businessName,
        dispatchCallNumber: dispatchCall || undefined,
      });
      provisionedNumber = result.phoneNumber;
      const { logPhoneEvent } = await import("../../lib/phone-number-history.js");
      await logPhoneEvent(slug, result.phoneNumber, result.phoneNumberSid, "provisioned");
      console.log(`[create-agent] provisioned number ${provisionedNumber} for "${slug}"`);
    } catch (provErr: unknown) {
      const msg = provErr instanceof Error ? provErr.message : String(provErr);
      provisionError = msg;
      console.error(`[create-agent] provisioning failed for "${slug}":`, msg);
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

    // Differentiate between validation/generation errors and Retell API errors
    const isValidation = message.includes("data point") || message.includes("Path ") ||
      message.includes("variableName") || message.includes("Unknown") ||
      message.includes("No data point defaults");
    const status = isValidation ? 400 : 502;
    const errorLabel = isValidation
      ? "Agent generation failed"
      : "Failed to create agent in Retell";

    // Extract Retell API error details if available
    let details = message;
    if ((err as any)?.status) details += ` (HTTP ${(err as any).status})`;
    if ((err as any)?.error?.message) details = (err as any).error.message;

    res.status(status).json({ error: errorLabel, details });
  }
}
