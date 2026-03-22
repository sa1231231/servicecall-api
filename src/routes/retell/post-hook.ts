import type { Request, Response } from "express";
import { config } from "../../config.js";
import { verifyRetellWebhookOr401 } from "../../lib/verify-retell.js";
import {
  msToIso,
  roundTo1Decimal,
  roundUpToTenthCent,
} from "../../lib/utils.js";

const MARKUP_CENTS = 0;

export async function postHookHandler(req: Request, res: Response) {
  console.log("retell-post-hook: received request");

  const sig = (req.headers["x-retell-signature"] as string) ?? "";
  const rawBody = (req as any).rawBody as string;

  // 1) Verify Retell signature
  if (!verifyRetellWebhookOr401(rawBody, sig, config.RETELL_SIGNATURE_KEY, res)) return;

  console.log("retell-post-hook: signature verified");

  // 2) Parse payload (already parsed by express.json on the retell router)
  const body = req.body;

  const eventType = body?.event ?? null;

  if (eventType !== "call_ended") {
    console.log("retell-post-hook: ignored event type", { event: eventType });
    res.status(200).json({
      ok: true,
      outcome: "ignored_event",
      message: "Event type ignored (phase 1).",
      event: eventType,
    });
    return;
  }

  const call = body?.call ?? null;
  if (!call || typeof call !== "object") {
    console.error("retell-post-hook: missing call object");
    res.status(400).json({
      ok: false,
      outcome: "missing_call",
      message: "Missing call object on call_ended payload.",
    });
    return;
  }

  const callId = call?.call_id ?? null;
  const agentId = call?.agent_id ?? null;

  if (!callId || !agentId) {
    console.error("retell-post-hook: missing call_id/agent_id", { call_id: callId, agent_id: agentId });
    res.status(400).json({
      ok: false,
      outcome: "missing_required_fields",
      message: "Missing required fields: call.call_id and/or call.agent_id.",
      call_id: callId,
      agent_id: agentId,
    });
    return;
  }

  // Validate Cost
  const combinedCostRaw = call?.call_cost?.combined_cost;

  if (combinedCostRaw === null || combinedCostRaw === undefined) {
    console.error("retell-post-hook: combined_cost missing", { call_id: callId });
    res.status(400).json({
      ok: false,
      outcome: "missing_combined_cost",
      message: "call.call_cost.combined_cost is required but was missing. Billing aborted.",
      call_id: callId,
      agent_id: agentId,
    });
    return;
  }

  if (typeof combinedCostRaw !== "number" || !Number.isFinite(combinedCostRaw)) {
    console.error("retell-post-hook: combined_cost invalid", { call_id: callId, combined_cost: combinedCostRaw });
    res.status(400).json({
      ok: false,
      outcome: "invalid_combined_cost",
      message: "call.call_cost.combined_cost must be a finite number. Billing aborted.",
      call_id: callId,
      agent_id: agentId,
      combined_cost: combinedCostRaw,
    });
    return;
  }

  // Timing
  const durationMs = call?.duration_ms ?? null;
  const durationSeconds =
    typeof durationMs === "number"
      ? Math.max(0, Math.round(durationMs / 1000))
      : typeof call?.call_cost?.total_duration_seconds === "number"
        ? call.call_cost.total_duration_seconds
        : 0;

  const startedAtIso = msToIso(call?.start_timestamp);
  const endedAtIso = msToIso(call?.end_timestamp);

  // Cost math
  const baseCost = roundUpToTenthCent(combinedCostRaw);
  const totalCostRaw = baseCost + MARKUP_CENTS;
  const totalCost = roundTo1Decimal(roundUpToTenthCent(totalCostRaw));

  console.log("retell-post-hook: parsed call_ended", {
    call_id: callId,
    agent_id: agentId,
    combined_cost_raw: combinedCostRaw,
    base_cost_cents: baseCost,
    markup_cents: MARKUP_CENTS,
    total_charge_cents: totalCost,
    duration_seconds: durationSeconds,
    started_at: startedAtIso,
    ended_at: endedAtIso,
  });

  // TODO: Look up agent -> business mapping
  // TODO: Call record_usage_and_debit for atomic billing

  res.status(200).json({
    ok: true,
    outcome: "processed",
    call_id: callId,
    agent_id: agentId,
    total_charge_cents: totalCost,
    duration_seconds: durationSeconds,
  });
}
