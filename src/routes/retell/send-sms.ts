import type { Request, Response } from "express";
import { config } from "../../config.js";
import { sendSmsForCall } from "../../lib/send-sms-service.js";

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

  const call = req.body?.call ?? null;
  const args = req.body?.args ?? {};

  const result = await sendSmsForCall({
    agentId: typeof call?.agent_id === "string" ? call.agent_id : null,
    callId: typeof call?.call_id === "string" && call.call_id ? call.call_id : null,
    fromNumber: typeof call?.from_number === "string" ? call.from_number : "",
    message: typeof args.message === "string" ? args.message : "",
    to: typeof args.to === "string" ? args.to : undefined,
    source: "retell_tool",
  });

  if (result.ok) {
    res.status(200).json({ success: true, result: result.result });
  } else {
    res.status(result.status).json({ success: false, error: result.error });
  }
}
