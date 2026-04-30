import type { Request, Response } from "express";
import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import { agentIdToClient, agentIdToSlug } from "../../_cache/clients.js";

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

  // 3) Check if agent is active
  if (agentId) {
    const client = agentIdToClient[agentId];
    const slug = agentIdToSlug[agentId] ?? "unknown";

    if (client && client.active === false) {
      console.log("retell-pre-hook: agent inactive, rejecting call", {
        agent_id: agentId,
        client: slug,
        to_number: toNumber,
      });
      res.status(200).json({});
      return;
    }
  }

  // TODO: Verify business has credit balance > 0

  console.log("retell-pre-hook: inbound call validated", {
    agent_id: agentId,
    to_number: toNumber,
    event_type: eventType,
  });

  // Accept the call — return the event key so Retell proceeds
  const responseKey = eventType === "call_inbound" ? "call_inbound" : "chat_inbound";
  res.status(200).json({ [responseKey]: {} });
}
