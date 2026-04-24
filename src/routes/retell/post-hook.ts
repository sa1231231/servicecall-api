import type { Request, Response } from "express";
import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import { sendSmsToAll } from "../../lib/notify-sms.js";
import { sendEmail, getEmailStatus } from "../../lib/notify-email.js";
import { ownerConfig } from "../../config/notification-clients.js";
import { agentIdToClient, agentIdToSlug } from "../../_cache/clients.js";
import { escapeHtml } from "../../lib/escape-html.js";
import { buildNotificationMessages } from "../../lib/build-notification.js";
import { sendOwnerCallMonitor } from "../../lib/owner-monitor.js";
import { triggerDispatchCall } from "../../lib/dispatch-call.js";
import { saveCallLog, type CallLogDocument } from "../../lib/call-log.js";

export async function postHookHandler(req: Request, res: Response) {
  console.log("retell-post-hook: received request");

  // Skip signature verification for test client (matched by agent_id)
  const agentId = req.body?.call?.agent_id ?? null;
  const isTestClient = agentIdToClient[agentId]?.name === "Test Client";

  if (!isTestClient) {
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

  // Look up client by agent_id
  const clientConfig = agentId ? agentIdToClient[agentId] : null;

  if (!clientConfig) {
    console.warn(
      `retell-post-hook: no config for agent_id="${agentId}", skipping notifications`,
    );
    res.status(200).json({ success: true });
    return;
  }

  console.log(`retell-post-hook: matched client "${clientConfig.name}" (agent_id=${agentId})`);

  const client = clientConfig; // local const for use in nested function
  const clientSlug = agentIdToSlug[agentId] ?? "unknown";

  function buildCallLog(
    outcome: string,
    typeKey = "",
    typeLabel = "",
    fields: Record<string, string> = {},
  ): CallLogDocument {
    return {
      _id: call.call_id ?? `unknown_${Date.now()}`,
      client_slug: clientSlug,
      client_name: client.name,
      agent_id: agentId,
      from_number: call.from_number ?? "unknown",
      duration_ms: call.duration_ms ?? 0,
      disconnection_reason: call.disconnection_reason ?? "unknown",
      all_variables: allVars,
      extracted_fields: fields,
      message_type_key: typeKey,
      message_type_label: typeLabel,
      outcome,
      shadow_mode: client.shadow_mode ?? false,
      created_at: new Date(),
    };
  }

  // Build notification messages
  const buildResult = buildNotificationMessages({
    clientConfig,
    allVars,
    callerNumber: call?.from_number,
  });

  if (!buildResult.ok) {
    const { reason, details } = buildResult;
    if (reason === "no_message_type") {
      console.error(`retell-post-hook: ${details}`);
      res.status(500).json({ success: false, message: "No message type configured." });
      return;
    }

    const typeKey = clientConfig.resolve_type(allVars);
    const messageType = clientConfig.message_types[typeKey] ?? clientConfig.message_types[clientConfig.default_message_type];
    const typeLabel = messageType?.label ?? "";

    if (reason === "failed_required") {
      console.warn(`retell-post-hook: ${details}, skipping notification`);
      saveCallLog(buildCallLog("skipped_required_field", typeKey, typeLabel, {})).catch(() => {});
      sendOwnerCallMonitor(call, clientConfig, "skipped_required_field").catch(() => {});
      res.status(200).json({ success: true, outcome: "skipped_required_field" });
      return;
    }

    // empty_call
    console.warn("retell-post-hook: empty call — no data collected, skipping notifications");
    saveCallLog(buildCallLog("skipped_empty_call", typeKey, typeLabel, {})).catch(() => {});
    sendOwnerCallMonitor(call, clientConfig, "skipped_empty_call").catch(() => {});
    res.status(200).json({ success: true, outcome: "skipped_empty_call" });
    return;
  }

  const { typeKey, messageType, fieldValues, smsMessage, emailBody, emailHtml, emailSubject } = buildResult.payload;

  console.log("retell-post-hook: extracted notification data", {
    agent_id: agentId,
    message_type: typeKey,
    fields: fieldValues,
  });

  // ── Shadow Dry-Run ─────────────────────────────────────────────────
  if (clientConfig.shadow_mode) {
    const dryRunSummary =
      `[SHADOW DRY-RUN] client="${clientConfig.name}"\n\n` +
      `Original dispatch numbers: ${JSON.stringify(clientConfig.dispatch_text_numbers)}\n` +
      `Original dispatch emails:  ${JSON.stringify(clientConfig.dispatch_email)}\n\n` +
      `--- SMS PREVIEW ---\n${smsMessage}\n\n` +
      `--- EMAIL PREVIEW ---\nSubject: ${emailSubject}\n\n${emailBody}`;

    console.log(`retell-post-hook: ${dryRunSummary}`);

    // Send the dry-run preview to owner so they can see exact formatting
    const shadowTasks: Promise<unknown>[] = [
      sendSmsToAll([ownerConfig.phone], `[SHADOW DRY-RUN] ${clientConfig.name}\n\n--- SMS that would be sent ---\n\n${smsMessage}`),
      sendEmail({
        to: ownerConfig.email,
        subject: `[SHADOW DRY-RUN] ${emailSubject}`,
        body: dryRunSummary,
        html: `<p><strong>[SHADOW DRY-RUN]</strong> for client "${escapeHtml(clientConfig.name)}"</p>` +
          `<p>Original dispatch numbers: ${escapeHtml(JSON.stringify(clientConfig.dispatch_text_numbers))}<br>` +
          `Original dispatch emails: ${escapeHtml(JSON.stringify(clientConfig.dispatch_email))}</p>` +
          `<hr><p><strong>SMS Preview:</strong></p><pre>${escapeHtml(smsMessage)}</pre>` +
          `<hr><p><strong>Email Preview (as client would see it):</strong></p>` +
          `<p>Subject: ${escapeHtml(emailSubject)}</p>${emailHtml}`,
      }),
    ];

    await Promise.allSettled(shadowTasks);

    // Shadow mode: dispatch call goes to owner instead of client
    if (clientConfig.summary_agent_id && clientConfig.outbound_from_number) {
      triggerDispatchCall(
        { ...clientConfig, dispatch_call_number: ownerConfig.phone },
        { client_name: clientConfig.name, call_summary: smsMessage },
      ).catch(() => {});
    }

    saveCallLog(buildCallLog("shadow_dry_run", typeKey, messageType.label, fieldValues)).catch(() => {});
    sendOwnerCallMonitor(call, clientConfig, "shadow_dry_run").catch(() => {});
    res.status(200).json({ success: true, outcome: "shadow_dry_run" });
    return;
  }

  console.log(
    `retell-post-hook: sending notifications for client "${clientConfig.name}"`,
  );

  const tasks: Promise<unknown>[] = [];
  const emailResendIds: string[] = [];

  if (clientConfig.dispatch_text_numbers.length > 0) {
    tasks.push(sendSmsToAll(clientConfig.dispatch_text_numbers, smsMessage));
  } else {
    console.log(
      "retell-post-hook: no dispatch numbers configured, skipping SMS",
    );
  }

  if (clientConfig.dispatch_email && clientConfig.dispatch_email.length > 0) {
    for (const email of clientConfig.dispatch_email) {
      const emailTask = sendEmail({
        to: email,
        cc: clientConfig.dispatch_cc,
        subject: emailSubject,
        body: emailBody,
        html: emailHtml,
      }).then((data) => {
        if (data?.id) emailResendIds.push(data.id);
        return data;
      });
      tasks.push(emailTask);
    }
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
      saveCallLog(buildCallLog("dispatch_error", typeKey, messageType.label, fieldValues)).catch(() => {});
      sendOwnerCallMonitor(call, clientConfig, "dispatch_error").catch(() => {});
      res.status(500).json({ success: false, errors });
      return;
    }

    // Summary log
    const smsCount = clientConfig.dispatch_text_numbers.length;
    const emailCount = clientConfig.dispatch_email?.length ?? 0;
    const callId = call?.call_id ?? "unknown";
    console.log(
      `retell-post-hook: notification summary | client="${clientConfig.name}" | call_id=${callId} | sms=${smsCount}/${smsCount} sent | email=${emailCount}/${emailCount} sent`,
    );

    // Fire-and-forget: check email delivery status after a delay
    for (const resendId of emailResendIds) {
      checkEmailDelivery(resendId, clientConfig.name).catch(() => {});
    }
  } else {
    console.warn(
      "retell-post-hook: no notification channels configured for this client",
    );
  }

  // Fire-and-forget: voice call to dispatch
  if (clientConfig.dispatch_call_number) {
    triggerDispatchCall(clientConfig, {
      client_name: clientConfig.name,
      call_summary: smsMessage,
    }).catch(() => {});
  }

  saveCallLog(buildCallLog("dispatched", typeKey, messageType.label, fieldValues)).catch(() => {});
  sendOwnerCallMonitor(call, clientConfig, "dispatched").catch(() => {});
  res.status(200).json({ success: true });
}

const EMAIL_CHECK_DELAY_MS = 5_000;
const EMAIL_PROBLEM_STATUSES = new Set([
  "bounced",
  "complained",
  "failed",
  "delivery_delayed",
]);

const ALERT_EMAIL = ownerConfig.email;

async function checkEmailDelivery(resendId: string, clientName: string) {
  await new Promise((r) => setTimeout(r, EMAIL_CHECK_DELAY_MS));
  try {
    const status = await getEmailStatus(resendId);
    const lastEvent = status?.last_event ?? "unknown";
    if (EMAIL_PROBLEM_STATUSES.has(lastEvent)) {
      console.error(
        `retell-post-hook: EMAIL DELIVERY PROBLEM | client="${clientName}" | resend_id=${resendId} | status=${lastEvent} | to=${status?.to} | cc=${status?.cc}`,
      );
      // Alert via email
      await sendEmail({
        to: ALERT_EMAIL,
        subject: `[SCS Alert] Email delivery problem for ${clientName}`,
        body: `Email delivery issue detected.\n\nClient: ${clientName}\nStatus: ${lastEvent}\nResend ID: ${resendId}\nTo: ${status?.to}\nCC: ${status?.cc}\nSubject: ${status?.subject}\nSent at: ${status?.created_at}`,
      });
    } else {
      console.log(
        `retell-post-hook: email status OK | client="${clientName}" | resend_id=${resendId} | status=${lastEvent}`,
      );
    }
  } catch (err: any) {
    console.error(
      `retell-post-hook: failed to check email status | resend_id=${resendId} | error=${err.message}`,
    );
  }
}

