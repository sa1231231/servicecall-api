import Retell from "retell-sdk";
import Twilio from "twilio";
import { config } from "../config.js";
import { logPhoneEvent, lookupSidFromHistory } from "./phone-number-history.js";

// Per-number released info returned to callers (and used in audit logs).
export interface ReleasedPhoneNumber {
  phone_number: string;
  phone_number_sid: string;
}

export interface AgentResourceReleaseResult {
  released: ReleasedPhoneNumber[];
  errors: string[];
}

/**
 * Release every external resource a client/agent owned: Retell phone-number
 * bindings, Retell agents + conversation flows, and Twilio's messaging-service
 * + trunk + incoming-phone-number entries. The Twilio incoming-number release
 * is the one that actually stops the recurring per-number charge.
 *
 * Best-effort: each external call is wrapped in its own try/catch so a
 * partial failure on one number/resource doesn't block the rest. Per-failure
 * messages are returned in `errors` for the caller to surface in the response
 * or audit log. The Mongo delete itself is the caller's responsibility.
 *
 * Source of truth for "which numbers does this agent currently have":
 * `retell.phoneNumber.list()` filtered to numbers whose inbound_agents or
 * outbound_agents include any agent_id this slug owns (doc.agent_id +
 * keys of doc.retell_agents). The Twilio SID needed to release the
 * incoming-number is looked up from `phone_number_history` for that
 * phone — Retell doesn't know about Twilio SIDs.
 *
 * Trade-off: if a number was manually unbound from this agent in Retell
 * before hard-delete, this helper will NOT release the Twilio number for
 * it. That matches the user's stated model: "what's bound at delete-time
 * is what gets cleaned up." Numbers we provisioned but later detached
 * are the operator's to clean up manually.
 */
export async function releaseAgentResources(
  slug: string,
  doc: {
    agent_id?: string | null;
    retell_agents?: Record<string, unknown> | null;
  },
  logTag = "release-agent",
): Promise<AgentResourceReleaseResult> {
  const released: ReleasedPhoneNumber[] = [];
  const errors: string[] = [];

  const retell = new Retell({ apiKey: config.RETELL_API_KEY });
  const twilioClient = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);

  // ── 1. Phone numbers — Retell-live source of truth ────────────────────────
  const agentIds = new Set<string>(
    [
      ...(doc.agent_id ? [doc.agent_id] : []),
      ...Object.keys(doc.retell_agents ?? {}),
    ].filter(Boolean),
  );

  const numbers = await currentlyBoundNumbers(retell, agentIds, errors, logTag);
  for (const phone_number of numbers) {
    // Retell binding — once deleted, calls won't route through Retell to
    // this (now-deleted) agent. Safe to call even if Retell already
    // unbound it; 404s are silenced (already gone).
    try {
      await retell.phoneNumber.delete(phone_number);
      console.log(`[${logTag}] removed Retell phone-number binding for ${phone_number}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/404/.test(msg)) {
        console.warn(`[${logTag}] retell.phoneNumber.delete(${phone_number}): ${msg}`);
        errors.push(`retell.phoneNumber.delete(${phone_number}): ${msg}`);
      }
    }

    // SID is needed for every Twilio call — Retell doesn't surface it, so
    // we pull it from phone_number_history (the most-recent provisioned
    // event for this slug + number).
    const phone_number_sid = await lookupSidFromHistory(slug, phone_number);
    if (!phone_number_sid) {
      const note = `no Twilio SID on file for ${phone_number} — number not released from Twilio, may still incur charges`;
      console.warn(`[${logTag}] ${note}`);
      errors.push(note);
      continue;
    }

    // Twilio messaging-service detach (must happen before Twilio release).
    if (config.TWILIO_MESSAGING_SERVICE_SID) {
      try {
        await twilioClient.messaging.v1
          .services(config.TWILIO_MESSAGING_SERVICE_SID)
          .phoneNumbers(phone_number_sid)
          .remove();
        console.log(`[${logTag}] detached ${phone_number} from messaging service`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 20404: not found — already detached. Treat as informational.
        if (!/20404|404/.test(msg)) {
          console.warn(`[${logTag}] twilio messaging-service detach (${phone_number}): ${msg}`);
          errors.push(`twilio messaging-service detach (${phone_number}): ${msg}`);
        }
      }
    }

    // Twilio trunk detach (must happen before Twilio release).
    if (config.TWILIO_TRUNK_SID) {
      try {
        await twilioClient.trunking.v1
          .trunks(config.TWILIO_TRUNK_SID)
          .phoneNumbers(phone_number_sid)
          .remove();
        console.log(`[${logTag}] detached ${phone_number} from trunk`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/20404|404/.test(msg)) {
          console.warn(`[${logTag}] twilio trunk detach (${phone_number}): ${msg}`);
          errors.push(`twilio trunk detach (${phone_number}): ${msg}`);
        }
      }
    }

    // Clear emergency address before release — Twilio blocks .remove()
    // on numbers that have one attached ("Please remove the emergency
    // address on this number before deleting it."). Best-effort; the
    // .remove() block below surfaces any real remaining blocker.
    //
    // Important: Twilio rejects updates that modify both EmergencyStatus
    // and EmergencyAddressSid in the same request ("Cannot modify both
    // emergency address SID and emergency status in the same request").
    // Empirically, only clearing EmergencyAddressSid is needed — the
    // delete gate is the address itself, not the status flag.
    //
    // The unbind is also async: emergency_address_status drops to
    // "pending-unregistration" immediately, then settles at
    // "unregistered" after ~30s of Twilio backend work. Trying .remove()
    // during the pending window returns the same 21631 error as before,
    // so we retry the release on 21631 with backoff to bridge that
    // window without the operator hitting "delete" again.
    try {
      await twilioClient.incomingPhoneNumbers(phone_number_sid).update({
        emergencyAddressSid: "",
      } as any);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/20404|404/.test(msg)) {
        console.warn(`[${logTag}] twilio emergency-clear (${phone_number}): ${msg}`);
      }
    }

    // Twilio incoming-number release — STOPS THE RECURRING CHARGE.
    // 404 here means the number was already released; silence it.
    // 21631 (emergency address still attached) gets retried with
    // backoff to bridge Twilio's async pending-unregistration window
    // (the address-clear above flips emergency_address_status to
    // "pending-unregistration" first, then settles at "unregistered"
    // after ~30s of Twilio backend work). Linear backoff 5s/10s/15s/20s/25s
    // — total ~75s max wait — empirically enough that operator-clicked
    // deletes succeed on the first try.
    let releasedOk = false;
    let lastErrMsg = "";
    let alreadyGone = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await twilioClient.incomingPhoneNumbers(phone_number_sid).remove();
        releasedOk = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastErrMsg = msg;
        if (/20404|404/.test(msg)) {
          alreadyGone = true;
          break;
        }
        // Retry only on 21631 (emergency address still attached) — any
        // other failure is bubbled up immediately.
        if (!/21631/.test(msg) || attempt === 6) break;
        await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
    if (releasedOk) {
      console.log(`[${logTag}] released Twilio number ${phone_number} (sid=${phone_number_sid})`);
      released.push({ phone_number, phone_number_sid });
      await logPhoneEvent(slug, phone_number, phone_number_sid, "released");
    } else if (alreadyGone) {
      // Already released — log the audit event so billing windows close.
      await logPhoneEvent(slug, phone_number, phone_number_sid, "released");
    } else {
      console.warn(`[${logTag}] twilio release (${phone_number}): ${lastErrMsg}`);
      errors.push(`twilio release (${phone_number}): ${lastErrMsg}`);
    }
  }

  // ── 2. Retell agents + conversation flows ─────────────────────────────────
  // 404s here are silenced — the operator may have already deleted the
  // agent manually in the Retell console, and that's fine; we just want to
  // converge on "gone" without filling cleanup_errors with not-found noise.
  const retellAgents = doc.retell_agents ?? {};
  for (const [agentId, agentJson] of Object.entries(retellAgents)) {
    await tryDeleteRetellAgent(retell, agentId, errors, logTag);
    const flowId =
      (agentJson as Record<string, any>)?.conversationFlow?.conversation_flow_id ??
      (agentJson as Record<string, any>)?.response_engine?.conversation_flow_id;
    if (flowId) await tryDeleteRetellFlow(retell, flowId, errors, logTag);
  }
  // Belt-and-suspenders: also delete the doc.agent_id if it isn't already
  // covered by the retell_agents map (legacy single-agent shape).
  if (doc.agent_id && !retellAgents[doc.agent_id]) {
    await tryDeleteRetellAgent(retell, doc.agent_id, errors, logTag);
  }

  return { released, errors };
}

async function tryDeleteRetellAgent(
  retell: Retell, agentId: string, errors: string[], logTag: string,
): Promise<void> {
  try {
    await retell.agent.delete(agentId);
    console.log(`[${logTag}] deleted Retell agent ${agentId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/404/.test(msg)) {
      console.warn(`[${logTag}] retell.agent.delete(${agentId}): ${msg}`);
      errors.push(`retell.agent.delete(${agentId}): ${msg}`);
    }
  }
}

async function tryDeleteRetellFlow(
  retell: Retell, flowId: string, errors: string[], logTag: string,
): Promise<void> {
  try {
    await retell.conversationFlow.delete(flowId);
    console.log(`[${logTag}] deleted Retell flow ${flowId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/404/.test(msg)) {
      console.warn(`[${logTag}] retell.conversationFlow.delete(${flowId}): ${msg}`);
      errors.push(`retell.conversationFlow.delete(${flowId}): ${msg}`);
    }
  }
}

/**
 * Source of truth at delete-time: query Retell for every phone number whose
 * inbound_agents OR outbound_agents include any agent_id this slug owns.
 * Returns just the phone numbers — the Twilio SID needed for billing-side
 * cleanup is looked up separately via `lookupSidFromHistory`.
 *
 * If `retell.phoneNumber.list()` itself throws (network outage, auth
 * mis-config, etc.) we record the error and return an empty list. The
 * caller still proceeds with Retell-agent + flow cleanup.
 */
async function currentlyBoundNumbers(
  retell: Retell,
  agentIds: Set<string>,
  errors: string[],
  logTag: string,
): Promise<string[]> {
  if (agentIds.size === 0) return [];
  let allNumbers: Array<{
    phone_number: string;
    inbound_agents?: Array<{ agent_id?: string }>;
  }>;
  try {
    allNumbers = (await retell.phoneNumber.list()) as any;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${logTag}] retell.phoneNumber.list: ${msg}`);
    errors.push(`retell.phoneNumber.list: ${msg}`);
    return [];
  }

  const matches: string[] = [];
  for (const n of allNumbers) {
    const inboundHit = (n.inbound_agents ?? []).some(
      (a) => a.agent_id && agentIds.has(a.agent_id),
    );
    // Some Retell SDK shapes also have outbound_agents on phone numbers;
    // include both so a number used only as outbound-from is still cleaned
    // up when its agent gets hard-deleted.
    const outboundHit = ((n as { outbound_agents?: Array<{ agent_id?: string }> })
      .outbound_agents ?? []).some(
      (a) => a.agent_id && agentIds.has(a.agent_id),
    );
    if (inboundHit || outboundHit) matches.push(n.phone_number);
  }
  return matches;
}

