import type { Request, Response } from "express";
import { config } from "../../config.js";
import { sendSmsFrom } from "../../lib/notify-sms.js";
import { agentIdToClient, agentIdToSlug } from "../../_cache/clients.js";
import { saveOutboundMessage } from "../../lib/outbound-messages.js";

const E164 = /^\+\d{8,15}$/;
const MAX_BODY = 1600;

// Retell custom-function calls (unlike agent webhooks like post-hook) are not
// HMAC-signed by Retell. Instead, the tool config in Retell carries a static
// `headers` map that's sent on every invocation. We require either a Bearer
// token in Authorization, or x-api-key — both matching API_KEY. Configure the
// matching header in the Retell tool's `headers` field.
function isAuthorized(req: Request): boolean {
  if (req.headers["x-api-key"] === config.API_KEY) return true;

  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token && token === config.API_KEY) return true;
  }
  return false;
}

export async function sendSmsHandler(req: Request, res: Response) {
  console.log("retell-send-sms: received request");

  if (!isAuthorized(req)) {
    console.warn("retell-send-sms: unauthorized — missing/invalid Bearer or x-api-key");
    res.status(401).json({
      success: false,
      error:
        "Unauthorized. Add 'Authorization: Bearer <API_KEY>' to the Retell tool's headers config.",
    });
    return;
  }

  const agentId = req.body?.call?.agent_id ?? null;

  const call = req.body?.call ?? null;
  const args = req.body?.args ?? {};

  const clientConfig = agentId ? agentIdToClient[agentId] : null;
  if (!clientConfig) {
    console.warn(`retell-send-sms: no config for agent_id="${agentId}"`);
    res.status(404).json({
      success: false,
      error: `No client configured for agent_id "${agentId}".`,
    });
    return;
  }

  const clientSlug = agentIdToSlug[agentId] ?? "unknown";

  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) {
    res.status(400).json({
      success: false,
      error: "Missing required argument: 'message' must be a non-empty string.",
    });
    return;
  }
  if (message.length > MAX_BODY) {
    res.status(400).json({
      success: false,
      error: `Message too long (${message.length} chars, max ${MAX_BODY}).`,
    });
    return;
  }

  const requestedTo = typeof args.to === "string" ? args.to.trim() : "";
  const callerNumber =
    typeof call?.from_number === "string" ? call.from_number.trim() : "";
  const to = requestedTo || callerNumber;

  if (!to || to === "Web Call" || to === "unknown") {
    res.status(400).json({
      success: false,
      error:
        "No recipient phone number. Pass 'to' in args, or call from a real phone number.",
    });
    return;
  }
  if (!E164.test(to)) {
    res.status(400).json({
      success: false,
      error: `Recipient '${to}' is not in E.164 format (e.g. +13015551234).`,
    });
    return;
  }

  const from = clientConfig.outbound_from_number || config.TWILIO_PHONE_NUMBER;

  const callId =
    typeof call?.call_id === "string" && call.call_id ? call.call_id : null;

  let twilioSid: string | null = null;
  let twilioStatus: string | null = null;
  let sendError: string | null = null;

  try {
    const result = await sendSmsFrom(from, to, message);
    twilioSid = result.sid ?? null;
    twilioStatus = result.status ?? null;
  } catch (err: any) {
    sendError = err?.message ?? String(err);
    console.error(`retell-send-sms: send failed (${from} → ${to}):`, sendError);
  }

  await saveOutboundMessage({
    call_id: callId,
    client_slug: clientSlug,
    client_name: clientConfig.name,
    agent_id: agentId,
    to,
    from,
    body: message,
    twilio_sid: twilioSid,
    twilio_status: twilioStatus,
    source: "retell_tool",
    error: sendError,
    created_at: new Date(),
  });

  if (sendError) {
    res.status(502).json({
      success: false,
      error: `Failed to send SMS: ${sendError}`,
    });
    return;
  }

  res.status(200).json({
    success: true,
    result: `Text message sent to ${to}.`,
  });
}
