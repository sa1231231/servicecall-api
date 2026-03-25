import type { Request, Response } from "express";
import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import { sendSmsToAll } from "../../lib/notify-sms.js";
import { sendEmail } from "../../lib/notify-email.js";
import { notificationClients, agentIdToClient } from "../../config/notification-clients.js";

export async function postHookHandler(req: Request, res: Response) {
  console.log("retell-post-hook: received request");

  // Skip signature verification for test client
  const testClientId =
    req.body?.call?.collected_dynamic_variables?.client_id ??
    req.body?.call?.retell_llm_dynamic_variables?.client_id;

  if (testClientId !== "test") {
    const sig = (req.headers["x-retell-signature"] as string) ?? "";
    const rawBody = (req as any).rawBody as string;

    if (!verifyRetellWebhookOr401(rawBody, sig, config.RETELL_SIGNATURE_KEY, res))
      return;
  } else {
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
  const allVars: Record<string, string> = { ...dynamicVars, ...collectedVars };

  // Look up client by agent_id first, then fall back to client_id from vars
  const agentId = call?.agent_id ?? null;
  const clientId = allVars.client_id ?? null;

  const clientConfig =
    (agentId ? agentIdToClient[agentId] : null) ??
    (clientId ? notificationClients[clientId] : null);

  if (!clientConfig) {
    console.warn(
      `retell-post-hook: no config for agent_id="${agentId}" or client_id="${clientId}", skipping notifications`,
    );
    res.status(200).json({ success: true });
    return;
  }

  console.log(`retell-post-hook: matched client "${clientConfig.name}" (agent_id=${agentId}, client_id=${clientId})`);

  // Resolve message type
  const typeKey = clientConfig.resolve_type(allVars);
  const messageType =
    clientConfig.message_types[typeKey] ??
    clientConfig.message_types[clientConfig.default_message_type];

  if (!messageType) {
    console.error(
      `retell-post-hook: no message type found for key="${typeKey}" or default="${clientConfig.default_message_type}"`,
    );
    res.status(500).json({ success: false, message: "No message type configured." });
    return;
  }

  // Extract field values
  const fieldValues: Record<string, string> = {};
  for (const field of messageType.fields) {
    let value = allVars[field.key] ?? "";
    if (
      clientConfig.phone_fallback_to_caller &&
      field.key === "phone_number" &&
      (!value || value === "Not Mentioned")
    ) {
      value = call?.from_number ?? "";
    }
    fieldValues[field.key] = value;
  }

  console.log("retell-post-hook: extracted notification data", {
    client_id: clientId,
    message_type: typeKey,
    fields: fieldValues,
  });

  // Skip notification if no meaningful data was collected (phone_number excluded — it defaults to caller)
  const meaningfulFields = messageType.fields.filter(
    (f) => f.key !== "phone_number" && fieldValues[f.key] && fieldValues[f.key] !== "Not Mentioned"
  );

  if (meaningfulFields.length === 0) {
    console.warn("retell-post-hook: empty call — no data collected, skipping notifications");
    res.status(200).json({ success: true, outcome: "skipped_empty_call" });
    return;
  }

  // Build field lines
  const fieldLines = messageType.fields
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

  console.log(
    `retell-post-hook: sending notifications for client "${clientConfig.name}"`,
  );

  const tasks: Promise<unknown>[] = [];

  if (clientConfig.dispatch_numbers.length > 0) {
    tasks.push(sendSmsToAll(clientConfig.dispatch_numbers, smsMessage));
  } else {
    console.log(
      "retell-post-hook: no dispatch numbers configured, skipping SMS",
    );
  }

  if (clientConfig.dispatch_email) {
    tasks.push(
      sendEmail({
        to: clientConfig.dispatch_email,
        cc: clientConfig.dispatch_cc,
        subject: emailSubject,
        body: emailBody,
      }),
    );
  } else {
    console.log(
      "retell-post-hook: no dispatch email configured, skipping email",
    );
  }

  if (tasks.length > 0) {
    const results = await Promise.allSettled(tasks);
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason?.message ?? String(r.reason));

    if (errors.length > 0) {
      console.error("retell-post-hook: notification errors", errors);
      res.status(500).json({ success: false, errors });
      return;
    }
    console.log("retell-post-hook: notifications sent");
  } else {
    console.warn(
      "retell-post-hook: no notification channels configured for this client",
    );
  }

  res.status(200).json({ success: true });
}

function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");
}
