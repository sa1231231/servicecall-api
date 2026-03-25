import type { Request, Response } from "express";
import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import { sendSmsToAll } from "../../lib/notify-sms.js";
import { sendEmail } from "../../lib/notify-email.js";
import { notificationClients } from "../../config/notification-clients.js";
import {
  msToIso,
  roundTo1Decimal,
  roundUpToTenthCent,
} from "../../lib/utils.js";

const MARKUP_CENTS = 0;

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

  const clientId = collectedVars?.client_id ?? dynamicVars?.client_id ?? null;
  const callType = collectedVars?.call_type ?? dynamicVars?.call_type ?? "";
  const fullName = collectedVars?.full_name ?? dynamicVars?.full_name ?? "";
  const rawPhone =
    collectedVars?.phone_number ?? dynamicVars?.phone_number ?? "";
  const phoneNumber =
    rawPhone && rawPhone !== "Not Mentioned"
      ? rawPhone
      : (call?.from_number ?? "");
  const address = collectedVars?.address ?? dynamicVars?.address ?? "";
  const problemDescription =
    collectedVars?.problem_description ??
    dynamicVars?.problem_description ??
    "";
  const timePreference =
    collectedVars?.time_preference ?? dynamicVars?.time_preference ?? "";

  const isEmergency = String(callType).toLowerCase().includes("emergency");
  const label = isEmergency ? "🚨 EMERGENCY CALL" : "📋 SERVICE QUOTE REQUEST";

  let message = `${label}\n\nName: ${fullName}\nPhone: ${phoneNumber}\nAddress: ${address}\nProblem: ${problemDescription}`;
  if (!isEmergency && timePreference) {
    message += `\nTime Preference: ${timePreference}`;
  }

  const emailSubject = `${label} — ${fullName} — ${address}`;

  console.log("retell-post-hook: extracted notification data", {
    client_id: clientId,
    call_type: callType,
    is_emergency: isEmergency,
    full_name: fullName,
    phone_number: phoneNumber,
    address,
    problem_description: problemDescription,
    time_preference: timePreference,
  });

  if (!clientId) {
    console.warn(
      "retell-post-hook: no client_id found, skipping notifications",
    );
  } else {
    const clientConfig = notificationClients[clientId];

    if (!clientConfig) {
      console.warn(
        `retell-post-hook: no config for client_id="${clientId}", skipping notifications`,
      );
    } else {
      console.log(
        `retell-post-hook: sending notifications for client "${clientConfig.name}"`,
      );

      const tasks: Promise<unknown>[] = [];

      if (clientConfig.dispatch_numbers.length > 0) {
        tasks.push(sendSmsToAll(clientConfig.dispatch_numbers, message));
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
            body: message,
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
    }
  }

  // // ── Billing / Cost Logic (kept separate for future use) ─────────────

  // const callId = call?.call_id ?? null;
  // const agentId = call?.agent_id ?? null;
  // const combinedCostRaw = call?.call_cost?.combined_cost;

  // if (callId && agentId && typeof combinedCostRaw === "number" && Number.isFinite(combinedCostRaw)) {
  //   const durationMs = call?.duration_ms ?? null;
  //   const durationSeconds =
  //     typeof durationMs === "number"
  //       ? Math.max(0, Math.round(durationMs / 1000))
  //       : typeof call?.call_cost?.total_duration_seconds === "number"
  //         ? call.call_cost.total_duration_seconds
  //         : 0;

  //   const startedAtIso = msToIso(call?.start_timestamp);
  //   const endedAtIso = msToIso(call?.end_timestamp);

  //   const baseCost = roundUpToTenthCent(combinedCostRaw);
  //   const totalCostRaw = baseCost + MARKUP_CENTS;
  //   const totalCost = roundTo1Decimal(roundUpToTenthCent(totalCostRaw));

  //   console.log("retell-post-hook: billing data", {
  //     call_id: callId,
  //     agent_id: agentId,
  //     combined_cost_raw: combinedCostRaw,
  //     base_cost_cents: baseCost,
  //     markup_cents: MARKUP_CENTS,
  //     total_charge_cents: totalCost,
  //     duration_seconds: durationSeconds,
  //     started_at: startedAtIso,
  //     ended_at: endedAtIso,
  //   });
  // }

  res.status(200).json({ success: true });
}
