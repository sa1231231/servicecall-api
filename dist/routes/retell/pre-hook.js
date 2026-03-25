import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
export async function preHookHandler(req, res) {
    const sig = req.headers["x-retell-signature"] ?? "";
    const rawBody = req.rawBody;
    // 1) Verify Retell signature
    if (!verifyRetellWebhookOr401(rawBody, sig, config.RETELL_SIGNATURE_KEY, res))
        return;
    // 2) Parse payload
    const body = req.body;
    console.log("retell-pre-hook: body", { body });
    const eventType = body?.event ?? null;
    const inbound = eventType === "call_inbound"
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
    const toNumber = inbound?.to_number ?? null;
    if (!toNumber) {
        console.log("retell-pre-hook: cannot find number in inbound payload, rejecting");
        res.status(200).json({});
        return;
    }
    // TODO: Look up agent by inbound number
    // TODO: Verify business has credit balance > 0
    // TODO: Return { call_inbound: { override_agent_id } } or {} to reject
    console.log("retell-pre-hook: inbound call validated", {
        to_number: toNumber,
        event_type: eventType,
    });
    res.status(200).json({});
}
