import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import { sendSmsToAll } from "../../lib/notify-sms.js";
import { sendEmail } from "../../lib/notify-email.js";
import { notificationClients } from "../../config/notification-clients.js";
export async function postHookHandler(req, res) {
    console.log("retell-post-hook: received request");
    // Skip signature verification for test client
    const testClientId = req.body?.call?.collected_dynamic_variables?.client_id ??
        req.body?.call?.retell_llm_dynamic_variables?.client_id;
    if (testClientId !== "test") {
        const sig = req.headers["x-retell-signature"] ?? "";
        const rawBody = req.rawBody;
        if (!verifyRetellWebhookOr401(rawBody, sig, config.RETELL_SIGNATURE_KEY, res))
            return;
    }
    else {
        console.log("retell-post-hook: skipping signature verification for test client");
    }
    console.log("retell-post-hook: signature verified");
    // 2) Parse payload
    const body = req.body;
    const eventType = body?.event ?? null;
    if (eventType !== "call_ended") {
        console.log("retell-post-hook: ignored event type", { event: eventType });
        res
            .status(200)
            .json({ success: true, outcome: "ignored_event", event: eventType });
        return;
    }
    const call = body?.call ?? null;
    if (!call || typeof call !== "object") {
        console.error("retell-post-hook: missing call object");
        res.status(400).json({ success: false, message: "Missing call object." });
        return;
    }
    // ── Notification Logic ──────────────────────────────────────────────
    const dynamicVars = call?.retell_llm_dynamic_variables ?? {};
    const collectedVars = call?.collected_dynamic_variables ?? {};
    const allVars = { ...dynamicVars, ...collectedVars };
    const clientId = allVars.client_id ?? null;
    if (!clientId) {
        console.warn("retell-post-hook: no client_id found, skipping notifications");
        res.status(200).json({ success: true });
        return;
    }
    const clientConfig = notificationClients[clientId];
    if (!clientConfig) {
        console.warn(`retell-post-hook: no config for client_id="${clientId}", skipping notifications`);
        res.status(200).json({ success: true });
        return;
    }
    // Resolve message type
    const typeKey = clientConfig.resolve_type(allVars);
    const messageType = clientConfig.message_types[typeKey] ??
        clientConfig.message_types[clientConfig.default_message_type];
    if (!messageType) {
        console.error(`retell-post-hook: no message type found for key="${typeKey}" or default="${clientConfig.default_message_type}"`);
        res.status(500).json({ success: false, message: "No message type configured." });
        return;
    }
    // Extract field values
    const fieldValues = {};
    for (const field of clientConfig.fields) {
        let value = allVars[field.key] ?? "";
        if (clientConfig.phone_fallback_to_caller &&
            field.key === "phone_number" &&
            (!value || value === "Not Mentioned")) {
            value = call?.from_number ?? "";
        }
        fieldValues[field.key] = value;
    }
    console.log("retell-post-hook: extracted notification data", {
        client_id: clientId,
        message_type: typeKey,
        fields: fieldValues,
    });
    // Build field lines
    const fieldLines = clientConfig.fields
        .map((f) => `${f.label}: ${fieldValues[f.key]}`)
        .filter((line) => !line.endsWith(": "))
        .join("\n");
    // Build message bodies
    const bodyCore = `${messageType.label}\n\n${fieldLines}`;
    const urgentSuffix = messageType.additional_text
        ? `\n\n${messageType.additional_text}`
        : "";
    const smsMessage = `${bodyCore}${urgentSuffix}\n\n— Service Call Saver`;
    const emailBody = `${bodyCore}${urgentSuffix}\n\n—\nSent by Service Call Saver\nservicecallsaver.com`;
    const emailSubject = renderTemplate(messageType.subject_template, fieldValues);
    console.log(`retell-post-hook: sending notifications for client "${clientConfig.name}"`);
    const tasks = [];
    if (clientConfig.dispatch_numbers.length > 0) {
        tasks.push(sendSmsToAll(clientConfig.dispatch_numbers, smsMessage));
    }
    else {
        console.log("retell-post-hook: no dispatch numbers configured, skipping SMS");
    }
    if (clientConfig.dispatch_email) {
        tasks.push(sendEmail({
            to: clientConfig.dispatch_email,
            cc: clientConfig.dispatch_cc,
            subject: emailSubject,
            body: emailBody,
        }));
    }
    else {
        console.log("retell-post-hook: no dispatch email configured, skipping email");
    }
    if (tasks.length > 0) {
        const results = await Promise.allSettled(tasks);
        const errors = results
            .filter((r) => r.status === "rejected")
            .map((r) => r.reason?.message ?? String(r.reason));
        if (errors.length > 0) {
            console.error("retell-post-hook: notification errors", errors);
            res.status(500).json({ success: false, errors });
            return;
        }
        console.log("retell-post-hook: notifications sent");
    }
    else {
        console.warn("retell-post-hook: no notification channels configured for this client");
    }
    res.status(200).json({ success: true });
}
function renderTemplate(template, values) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");
}
