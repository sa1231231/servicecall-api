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
    res.status(200).json({ [responseKey]: {} });
    return;
  }

  // 5) Check if agent is active
  if (client.active === false) {
    console.log("retell-pre-hook: agent inactive, rejecting call", {
      agent_id: resolvedAgentId,
      client: slug,
      to_number: toNumber,
    });
    // Override the call to deliver a short unavailable message then hang up.
    // This works regardless of whether the inbound agent is set on the number.
    res.status(200).json({
      [responseKey]: {
        agent_override: {
          agent: {
            end_call_after_silence_ms: 10000,
            max_call_duration_ms: 60000,
          },
          ...(eventType === "call_inbound"
            ? { conversation_flow: { begin_message: "We're sorry, this number is currently unavailable. Goodbye." } }
            : { retell_llm: { begin_message: "We're sorry, this service is currently unavailable." } }),
        },
      },
    });
    return;
  }

  // TODO: Verify business has credit balance > 0

  console.log("retell-pre-hook: inbound call validated", {
    agent_id: resolvedAgentId,
    client: slug,
    to_number: toNumber,
    event_type: eventType,
  });

  // Accept — pass through with no overrides (inbound agent on the number handles it)
  res.status(200).json({ [responseKey]: {} });
}
