import Retell from "retell-sdk";
import { config } from "../config.js";
import { notificationClients } from "../_cache/clients.js";
import { persistClient } from "../config/client-store.js";
import { provisionPhoneNumber } from "./provision-number.js";
import { getDataPointDefaults } from "./data-point-defaults.js";
import {
  generateAgent,
  type AgentConfig,
  type RawDataPoint,
  type DataPoint,
  type PathConfig,
  type FinetuneExample,
} from "./agent-generator/index.js";
import { isSendSmsAction } from "./agent-generator/data-point-registry.js";
import type { HumanRequestMode } from "./agent-generator/node-builders.js";
import {
  toLabel,
  deriveNotificationConfig,
  deriveMultiPathNotificationConfig,
  type VariableEntry,
} from "./notification-config.js";
import { extractFlowParams, extractAgentParams } from "./retell-sync.js";
import { extractAreaCode } from "./provision-number.js";
import { areaCodeToTimezone } from "./area-code-timezone.js";
import { getWarmTransferAgentVersion } from "./agent-generator/warm-transfer-agent-version.js";

// ── Request Body Type ────────────────────────────────────────────────────────

export interface CreateAgentBody {
  business: AgentConfig & { human_request_mode?: HumanRequestMode };
  dataPoints?: RawDataPoint[];
  paths?: Array<{
    name: string;
    transitionCondition: string;
    dataPoints: RawDataPoint[];
    end_mode?: "callback" | "transfer";
    /** Positive examples that route the caller to this path. Forwarded
     *  to PathConfig.transitionFinetuneExamples; merged into the intro
     *  node's finetune_transition_examples at generation time. */
    transitionFinetuneExamples?: FinetuneExample[];
  }>;
  client: {
    slug: string;
    name?: string;
    dispatch_text_numbers: string[];
    dispatch_call_number?: string | null;
    dispatch_call_overrides?: Record<string, string>;
    dispatch_email?: string[] | null;
    dispatch_cc?: string | null;
    dispatch_by_type?: Record<string, {
      dispatch_text_numbers?: string[];
      dispatch_email?: string[];
      dispatch_cc?: string | null;
      dispatch_call_number?: string | null;
    }>;
    path_end_modes?: Record<string, "callback" | "transfer">;
    outbound_from_number?: string | null;
    summary_agent_id?: string | null;
    webhook_url?: string;
    notification_greeting?: string;
    weekly_report_enabled?: boolean;
    phone_fallback_to_caller?: boolean;
    hide_not_mentioned?: boolean;
    shadow_mode?: boolean;
    /** Admin-only Client Contact info shown in the Billing tab. When
     *  provided, these win over the area-code-derived auto-populate
     *  for `contact_timezone`. Used by the lead-promotion flow to
     *  carry the lead's name/phone onto the resulting client doc. */
    contact_name?: string | null;
    contact_phone?: string | null;
    contact_email?: string | null;
    contact_timezone?: string | null;
    contact_notes?: string | null;
    /** Lineage + per-client opt-in for the transcript-review system.
     *  Set by the from-draft route when the source draft is `is_template`,
     *  but operators can also set them directly via the agent edit endpoint. */
    transcript_review_enabled?: boolean;
    source_draft?: string;
  };
}

// ── Result Types ─────────────────────────────────────────────────────────────

export interface CreateAgentSuccess {
  ok: true;
  agentId: string;
  conversationFlowId: string;
  slug: string;
  notificationConfig: Record<string, unknown>;
  provisionedNumber: string | null;
  provisionError: string | null;
}

export interface CreateAgentFailure {
  ok: false;
  status: number;
  error: string;
  details?: string;
}

export type CreateAgentResult = CreateAgentSuccess | CreateAgentFailure;

// ── Helpers ──────────────────────────────────────────────────────────────────

function flattenDataPoints(resolved: DataPoint[]): VariableEntry[] {
  const variables: VariableEntry[] = [];
  for (const dp of resolved) {
    if (dp.composite && dp.variables) {
      for (const v of dp.variables) {
        variables.push({ key: v.variableName, label: toLabel(v.variableName, v.label) });
      }
    } else {
      variables.push({ key: dp.variableName, label: toLabel(dp.variableName, dp.label) });
    }
  }
  return variables;
}

// ── Main Function ────────────────────────────────────────────────────────────

export async function createAgentFromConfig(body: CreateAgentBody): Promise<CreateAgentResult> {
  // ── Validate ───────────────────────────────────────────────────────────────
  if (!body.business?.businessName || !body.business?.faqKnowledgeBase) {
    return { ok: false, status: 400, error: "Missing required field: business.businessName and business.faqKnowledgeBase" };
  }

  const hasPaths = Array.isArray(body.paths) && body.paths.length > 0;
  const hasDataPoints = Array.isArray(body.dataPoints) && body.dataPoints.length > 0;

  if (!hasPaths && !hasDataPoints) {
    return { ok: false, status: 400, error: "Must provide either 'dataPoints' or 'paths' (non-empty)" };
  }

  if (hasPaths) {
    for (const [i, p] of body.paths!.entries()) {
      if (!p.name) {
        return { ok: false, status: 400, error: `paths[${i}].name is required` };
      }
      if (!p.transitionCondition) {
        return { ok: false, status: 400, error: `paths[${i}].transitionCondition is required` };
      }
      if (!Array.isArray(p.dataPoints)) {
        return { ok: false, status: 400, error: `paths[${i}].dataPoints must be an array` };
      }
      if (p.end_mode && p.end_mode !== "callback" && p.end_mode !== "transfer") {
        return { ok: false, status: 400, error: `paths[${i}].end_mode must be "callback" or "transfer"` };
      }
      if (p.end_mode === "transfer") {
        const perPath = body.client?.dispatch_by_type?.[p.name]?.dispatch_call_number;
        const fallback = body.client?.dispatch_call_number;
        if (!perPath && !fallback) {
          return {
            ok: false,
            status: 400,
            error: `paths[${i}] ("${p.name}") end_mode is "transfer" but no dispatch call number is set (per-path or client default)`,
          };
        }
      }
    }
  }

  if (!body.client?.slug) {
    return { ok: false, status: 400, error: "Missing required field: client.slug" };
  }
  // Require an explicit, non-empty client.name. We used to silently fall back
  // to the lowercased slug here (via `name: clientInfo.name ?? clientInfo.slug`
  // in buildClientEntry), which produced bugs like a "GMC" form input ending
  // up as "gmc" in the dashboard. Fail loudly instead.
  if (typeof body.client.name !== "string" || !body.client.name.trim()) {
    return {
      ok: false,
      status: 400,
      error: "Missing required field: client.name (no fallback to slug)",
    };
  }
  body.client.name = body.client.name.trim();
  // Fall back to owner phone if dispatch_text_numbers is empty
  if (!Array.isArray(body.client.dispatch_text_numbers) || body.client.dispatch_text_numbers.length === 0) {
    const { getSettings } = await import("./settings.js");
    const settings = await getSettings();
    if (settings.owner_phone) {
      body.client.dispatch_text_numbers = [settings.owner_phone];
    } else {
      return { ok: false, status: 400, error: "Missing dispatch_text_numbers and no owner phone configured in settings" };
    }
  }
  // Find a unique slug. If the requested slug is taken, append -2, -3, ...
  // until we find a free one. Lets onboarding flows that derive slug from
  // businessName create multiple agents for businesses with the same name
  // without manual disambiguation.
  const baseSlug = body.client.slug;
  let slug = baseSlug;
  let collisionCounter = 2;
  while (notificationClients[slug]) {
    slug = `${baseSlug}-${collisionCounter}`;
    collisionCounter++;
  }
  if (slug !== baseSlug) {
    console.log(`[create-agent] slug "${baseSlug}" taken; using "${slug}"`);
    body.client.slug = slug;
  }

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  let conversationFlowId: string | undefined;

  try {
    // ── 1. Generate agent JSON ─────────────────────────────────────────────
    const pathSummary = hasPaths
      ? `${body.paths!.length} path(s): ${body.paths!.map(p => `"${p.name}" (${p.dataPoints.length} dps)`).join(", ")}`
      : `${body.dataPoints!.length} data points (flat)`;
    console.log(`[create-agent] generating agent for "${body.business.businessName}" — ${pathSummary}`);
    const humanMode: HumanRequestMode = body.business.human_request_mode || "callback";
    const anyTransferPath = hasPaths && body.paths!.some((p) => p.end_mode === "transfer");
    const warmTransferAgentVersion =
      humanMode === "live_transfer" || anyTransferPath
        ? await getWarmTransferAgentVersion(retell)
        : undefined;
    // Load workspace defaults for FAQ + Close Question fine-tunes so newly
    // generated agents reflect operator-curated example sets. Empty arrays
    // are valid overrides; only `undefined` falls back to the hardcoded
    // FAQ_GLOBAL_POSITIVE_EXAMPLES / CLOSE_QUESTION_FAQ_FINETUNE_EXAMPLES.
    const { getSettings: loadSettings } = await import("./settings.js");
    const workspaceSettings = await loadSettings();
    const agentConfig: AgentConfig = {
      ...body.business,
      humanRequestMode: humanMode,
      closePrompt: body.business.closePrompt?.trim() || undefined,
      closeQuestionPrompt: body.business.closeQuestionPrompt?.trim() || undefined,
      closingRemarksPrompt: body.business.closingRemarksPrompt?.trim() || undefined,
      closingStatementText: body.business.closingStatementText?.trim() || undefined,
      liveTransferRecoveryPrompt: body.business.liveTransferRecoveryPrompt?.trim() || undefined,
      warmTransferAgentVersion,
      faqGlobalFinetuneExamples: workspaceSettings.faq_global_finetune_examples,
      closeQuestionFinetuneExamples:
        workspaceSettings.close_question_finetune_examples,
    };
    const dpDefaults = await getDataPointDefaults();
    const pathConfigs: PathConfig[] | undefined = hasPaths
      ? body.paths!.map((p) => {
          const endMode: "callback" | "transfer" =
            p.end_mode === "transfer" ? "transfer" : "callback";
          const transferDestination =
            endMode === "transfer"
              ? body.client?.dispatch_by_type?.[p.name]?.dispatch_call_number ||
                body.client?.dispatch_call_number ||
                undefined
              : undefined;
          return {
            name: p.name,
            transitionCondition: p.transitionCondition,
            dataPoints: p.dataPoints,
            endMode,
            transferDestination: transferDestination ?? undefined,
            transitionFinetuneExamples: p.transitionFinetuneExamples,
          };
        })
      : undefined;
    const { agent: agentJson, resolved, resolvedPaths } = generateAgent(
      agentConfig,
      body.dataPoints ?? [],
      pathConfigs,
      dpDefaults,
    );

    // ── 2. Create conversation flow in Retell ──────────────────────────────
    const conversationFlow = agentJson.conversationFlow as Record<string, unknown>;
    const flowParams = extractFlowParams(conversationFlow);

    console.log(`[create-agent] creating conversation flow in Retell...`);
    const flowResponse = await retell.conversationFlow.create(flowParams as any);
    conversationFlowId = flowResponse.conversation_flow_id;
    console.log(`[create-agent] conversation flow created: ${conversationFlowId}`);

    // ── 3. Create agent in Retell ──────────────────────────────────────────
    const agentParams = extractAgentParams(agentJson, conversationFlowId);

    console.log(`[create-agent] creating agent in Retell...`);
    const agentResponse = await retell.agent.create(agentParams as any);
    const agentId = agentResponse.agent_id;
    console.log(`[create-agent] agent created: ${agentId}`);

    // ── 4. Derive and persist notification config ──────────────────────────
    let jsonEntry;
    if (resolvedPaths && resolvedPaths.length > 1) {
      const pathVariables = resolvedPaths.map((p) => ({
        name: p.name,
        // Filter SMS actions out — notification config only cares about
        // DataPoints. SMS actions are inline flow steps, not collected data.
        variables: flattenDataPoints(
          p.resolved.filter((it): it is DataPoint => !isSendSmsAction(it)),
        ),
      }));
      jsonEntry = deriveMultiPathNotificationConfig(pathVariables, body.client, agentId);
    } else {
      const variables = flattenDataPoints(resolved);
      jsonEntry = deriveNotificationConfig(variables, body.client, agentId);
    }

    const canonicalJson = { ...agentJson, agent_id: agentId };
    jsonEntry.retell_agents = { [agentId]: canonicalJson };

    if (body.client.dispatch_by_type) {
      jsonEntry.dispatch_by_type = body.client.dispatch_by_type;
    }

    if (hasPaths) {
      const endModes: Record<string, "callback" | "transfer"> = {};
      for (const p of body.paths!) {
        if (p.end_mode === "transfer") endModes[p.name] = "transfer";
      }
      if (Object.keys(endModes).length > 0) {
        jsonEntry.path_end_modes = endModes;
      }
    }

    if (body.client.dispatch_call_overrides) {
      jsonEntry.dispatch_call_overrides = body.client.dispatch_call_overrides;
    }
    if (body.client.webhook_url) {
      jsonEntry.webhook_url = body.client.webhook_url;
    }
    if (body.client.notification_greeting) {
      jsonEntry.notification_greeting = body.client.notification_greeting;
    }
    if (typeof body.client.weekly_report_enabled === "boolean") {
      jsonEntry.weekly_report_enabled = body.client.weekly_report_enabled;
    }

    // Pass-through admin Client Contact fields. The lead-promotion flow
    // uses these to carry the lead's name + phone onto the new client
    // doc. Explicit values here win over the area-code auto-populate
    // below (so a lead's phone area code drives contact_timezone, not
    // the operator's dispatch_call_number).
    if (body.client.contact_name !== undefined) jsonEntry.contact_name = body.client.contact_name;
    if (body.client.contact_phone !== undefined) jsonEntry.contact_phone = body.client.contact_phone;
    if (body.client.contact_email !== undefined) jsonEntry.contact_email = body.client.contact_email;
    if (body.client.contact_timezone !== undefined) jsonEntry.contact_timezone = body.client.contact_timezone;
    if (body.client.contact_notes !== undefined) jsonEntry.contact_notes = body.client.contact_notes;
    if (body.client.source_draft !== undefined) jsonEntry.source_draft = body.client.source_draft;
    if (body.client.transcript_review_enabled !== undefined) {
      jsonEntry.transcript_review_enabled = body.client.transcript_review_enabled;
    }

    // Auto-populate Client Contact timezone from the dispatch number's area
    // code so the operator gets a sensible default in the Billing tab. Only
    // applied if a US area code we recognize maps to one of the four IANA
    // zones the dropdown supports, AND only when the caller didn't already
    // pass an explicit contact_timezone (lead-promote path).
    if (jsonEntry.contact_timezone === undefined) {
      const dispatchNumberForAreaCode = body.client.dispatch_call_number
        || (body.client.dispatch_by_type
          ? Object.values(body.client.dispatch_by_type).find(o => o.dispatch_call_number)?.dispatch_call_number
          : null);
      if (dispatchNumberForAreaCode) {
        const tz = areaCodeToTimezone(extractAreaCode(dispatchNumberForAreaCode));
        if (tz) jsonEntry.contact_timezone = tz;
      }
    }

    await persistClient(slug, jsonEntry);

    console.log(`[create-agent] client "${slug}" registered with agent ${agentId}`);

    // ── 5. Provision phone number ──────────────────────────────────────────
    let provisionedNumber: string | null = null;
    let provisionError: string | null = null;

    const dispatchCall = body.client.dispatch_call_number
      || (body.client.dispatch_by_type
        ? Object.values(body.client.dispatch_by_type).find(o => o.dispatch_call_number)?.dispatch_call_number
        : null)
      || undefined;

    try {
      const result = await provisionPhoneNumber({
        agentId,
        clientName: body.business.businessName,
        dispatchCallNumber: dispatchCall || undefined,
      });
      provisionedNumber = result.phoneNumber;
      const { logPhoneEvent } = await import("./phone-number-history.js");
      await logPhoneEvent(slug, result.phoneNumber, result.phoneNumberSid, "provisioned");
      // Persist the freshly-provisioned number on the client doc so
      // downstream flows (Send Instructions {{agent_phone}}, dispatch
      // routing, billing) can read it without a Retell round-trip. The
      // standalone /agents/provision-number route already does this; the
      // create + from-draft paths used to drop the value on the floor.
      const { updateClientField } = await import("../config/client-store.js");
      await updateClientField(slug, "outbound_from_number", result.phoneNumber);
      console.log(`[create-agent] provisioned number ${provisionedNumber} for "${slug}"`);
    } catch (provErr: unknown) {
      const msg = provErr instanceof Error ? provErr.message : String(provErr);
      provisionError = msg;
      console.error(`[create-agent] provisioning failed for "${slug}":`, msg);
    }

    return {
      ok: true,
      agentId,
      conversationFlowId: conversationFlowId!,
      slug,
      notificationConfig: jsonEntry as unknown as Record<string, unknown>,
      provisionedNumber,
      provisionError,
    };
  } catch (err: unknown) {
    console.error("[create-agent] error:", err);

    if (conversationFlowId) {
      try {
        console.log(`[create-agent] cleaning up conversation flow ${conversationFlowId}`);
        await retell.conversationFlow.delete(conversationFlowId);
      } catch (cleanupErr) {
        console.error("[create-agent] cleanup failed:", cleanupErr);
      }
    }

    const message = err instanceof Error ? err.message : "Unknown error";

    const isValidation = message.includes("data point") || message.includes("Path ") ||
      message.includes("variableName") || message.includes("Unknown") ||
      message.includes("No data point defaults");
    const status = isValidation ? 400 : 502;
    const errorLabel = isValidation
      ? "Agent generation failed"
      : "Failed to create agent in Retell";

    let details = message;
    if ((err as any)?.status) details += ` (HTTP ${(err as any).status})`;
    if ((err as any)?.error?.message) details = (err as any).error.message;

    return { ok: false, status, error: errorLabel, details };
  }
}
