import type { Request, Response } from "express";
import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import { agentIdToClient, agentIdToSlug, phoneNumberToClient } from "../../_cache/clients.js";

export async function preHookHandler(req: Request, res: Response) {
  const sig = (req.headers["x-retell-signature"] as string) ?? "";
  const rawBody = (req as any).rawBody as string;

  // 1) Verify Retell signature (SDK is async — must await or every Promise
  //    is truthy and the guard silently accepts forged signatures)
  if (!(await verifyRetellWebhookOr401(rawBody, sig, config.RETELL_SIGNATURE_KEY, res))) return;

  // 2) Parse payload
  const body = req.body;
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

  const agentId = inbound?.agent_id ?? null;
  const toNumber = inbound?.to_number ?? null;
  // Log only the routing-relevant fields. Caller phone (`from_number`)
  // and call_id are PII and should not land in Railway logs.
  console.log("retell-pre-hook: received inbound", { eventType, agent_id: agentId, to_number: toNumber });
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
      resolvedAgentId = client.agent_id ?? null;
      console.log("retell-pre-hook: resolved client by to_number", {
        to_number: toNumber,
        client: slug,
        resolved_agent_id: resolvedAgentId,
      });
    }
  }

  // 4) Log and pass through
  // Note: active/inactive rejection is handled at the Retell phone number level
  // (inbound_agents cleared via toggle-active endpoint), not here.
  console.log("retell-pre-hook: inbound call validated", {
    agent_id: resolvedAgentId,
    client: slug ?? "unknown",
    to_number: toNumber,
    event_type: eventType,
    active: client?.active !== false,
  });

  // Pass through — let Retell handle with the bound inbound agent
  res.status(200).json({ [responseKey]: {} });
}
