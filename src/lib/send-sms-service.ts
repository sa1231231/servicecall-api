// Shared SMS-send service. Single source of truth for the mid-call SMS
// pipeline: resolve client config, validate inputs, send via Twilio, log to
// the outbound_messages collection. Wrapped by:
//   - src/routes/retell/send-sms.ts — the legacy Retell CustomTool endpoint
//   - src/routes/mcp.ts — the MCP tools/call handler for send_sms
// Both wrappers handle their own auth + arg unpacking, then defer here.

import { config } from "../config.js";
import { sendSmsFrom } from "./notify-sms.js";
import { agentIdToClient, agentIdToSlug } from "../_cache/clients.js";
import { saveOutboundMessage } from "./outbound-messages.js";

const E164 = /^\+\d{8,15}$/;
const MAX_BODY = 1600;

export type SendSmsSource = "retell_tool" | "mcp";

export interface SendSmsArgs {
  /** Retell agent_id of the call this SMS is sent from. */
  agentId: string | null;
  /** Retell call_id, or null if invoked outside a live call (e.g. test). */
  callId: string | null;
  /** Caller's number from call.from_number. May be empty / "Web Call". */
  fromNumber: string;
  /** SMS body, before validation/trimming. */
  message: string;
  /** Optional E.164 recipient override; falls back to fromNumber. */
  to?: string;
  /** Tag stored on the outbound_messages row for downstream attribution. */
  source: SendSmsSource;
}

export type SendSmsResult =
  | { ok: true; status: 200; result: string }
  | { ok: false; status: 400 | 404 | 502; error: string };

export async function sendSmsForCall(args: SendSmsArgs): Promise<SendSmsResult> {
  const { agentId, callId, fromNumber, source } = args;

  const clientConfig = agentId ? agentIdToClient[agentId] : null;
  if (!clientConfig) {
    console.warn(`send-sms-service: no config for agent_id="${agentId}"`);
    return { ok: false, status: 404, error: `No client configured for agent_id "${agentId}".` };
  }
  const clientSlug = (agentId && agentIdToSlug[agentId]) ?? "unknown";

  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) {
    return { ok: false, status: 400, error: "Missing required argument: 'message' must be a non-empty string." };
  }
  if (message.length > MAX_BODY) {
    return { ok: false, status: 400, error: `Message too long (${message.length} chars, max ${MAX_BODY}).` };
  }

  const requestedTo = typeof args.to === "string" ? args.to.trim() : "";
  const callerNumber = typeof fromNumber === "string" ? fromNumber.trim() : "";
  const to = requestedTo || callerNumber;

  if (!to || to === "Web Call" || to === "unknown") {
    return { ok: false, status: 400, error: "No recipient phone number. Pass 'to' in args, or call from a real phone number." };
  }
  if (!E164.test(to)) {
    return { ok: false, status: 400, error: `Recipient '${to}' is not in E.164 format (e.g. +13015551234).` };
  }

  const from = clientConfig.outbound_from_number || config.TWILIO_PHONE_NUMBER;

  let twilioSid: string | null = null;
  let twilioStatus: string | null = null;
  let sendError: string | null = null;

  try {
    const result = await sendSmsFrom(from, to, message);
    twilioSid = result.sid ?? null;
    twilioStatus = result.status ?? null;
  } catch (err: any) {
    sendError = err?.message ?? String(err);
    console.error(`send-sms-service: send failed (${from} → ${to}):`, sendError);
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
    source,
    error: sendError,
    created_at: new Date(),
  });

  if (sendError) {
    return { ok: false, status: 502, error: `Failed to send SMS: ${sendError}` };
  }

  return { ok: true, status: 200, result: `Text message sent to ${to}.` };
}
