import type { Request, Response } from "express";
import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import { agentIdToClient, agentIdToSlug, phoneNumberToClient } from "../../_cache/clients.js";

export async function preHookHandler(req: Request, res: Response) {
  const sig = (req.headers["x-retell-signature"] as string) ?? "";
  const rawBody = (req as any).rawBody as string;

  // 1) Verify Retell signature
  if (!verifyRetellWebhookOr401(rawBody, sig, config.RETELL_SIGNATURE_KEY, res)) return;

  // 2) Parse payload
  const body = req.body;

  console.log("retell-pre-hook: body", { body });

  const eventType = body?.event ?? null;

  const inbound =
    eventType === "call_inbound"
      ? body?.call_inbound
      : eventType === "chat_inbound"
        ? body?.chat_inbound
        : null;

  if (!inbound) {
    console.log("retell-pre-hook: not inbound event, ignoring", { eventType });
    res.status(200).json({
      ok: true,
      outcome: "ignored_event",
      event: eventType,
    });
    return;
  }

  console.log("retell-pre-hook: Received inbound event:", { eventType, inbound });

  const agentId = inbound?.agent_id ?? null;
  const toNumber = inbound?.to_number ?? null;
  const responseKey = eventType === "call_inbound" ? "call_inbound" : "chat_inbound";

  // 3) Resolve client — try agent_id first, fall back to to_number
  let client = agentId ? agentIdToClient[agentId] : null;
  let slug = agentId ? (agentIdToSlug[agentId] ?? null) : null;
  let resolvedAgentId = agentId;

  if (!client && toNumber) {
    const byPhone = phoneNumberToClient[toNumber];
    if (byPhone) {
      client = byPhone.config;
      slug = byPhone.slug;
      // Use first agent_id from client config since the number has no bound agent
      resolvedAgentId = client.agent_ids[0] ?? null;
      console.log("retell-pre-hook: resolved client by to_number", {
        to_number: toNumber,
        client: slug,
        resolved_agent_id: resolvedAgentId,
      });
    }
  }

  // 4) If we can't identify the client, pass through without blocking
  if (!client) {
    console.log("retell-pre-hook: unknown agent/number, passing through", {
      agent_id: agentId,
      to_number: toNumber,
    });
    res.status(200).json({
      [responseKey]: {
        ...(agentId ? { override_agent_id: agentId } : {}),
      },
    });
    return;
  }

  // 5) Check if agent is active
  if (client.active === false) {
    console.log("retell-pre-hook: agent inactive, rejecting call", {
      agent_id: resolvedAgentId,
      client: slug,
      to_number: toNumber,
    });
    // Omit override_agent_id → Retell rejects the call
    res.status(200).json({ [responseKey]: {} });
    return;
  }

  // TODO: Verify business has credit balance > 0

  console.log("retell-pre-hook: inbound call validated", {
    agent_id: resolvedAgentId,
    client: slug,
    to_number: toNumber,
    event_type: eventType,
  });

  // Accept — return override_agent_id so Retell connects the call
  res.status(200).json({
    [responseKey]: {
      ...(resolvedAgentId ? { override_agent_id: resolvedAgentId } : {}),
    },
  });
}
