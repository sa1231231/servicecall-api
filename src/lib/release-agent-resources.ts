import Retell from "retell-sdk";
import Twilio from "twilio";
import { config } from "../config.js";
import { logPhoneEvent } from "./phone-number-history.js";
import { getDb } from "./db.js";

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
 * Source of truth for "which numbers does this slug own": the
 * `phone_number_history` collection (provisioned events without a matching
 * released event). Falls back to nothing if the collection is empty.
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

  // ── 1. Phone numbers (Retell binding + Twilio resources) ──────────────────
  const numbers = await activePhoneNumbersFor(slug);
  for (const n of numbers) {
    // Retell binding — once deleted, calls won't route through Retell to
    // this (now-deleted) agent. Safe to call even if Retell already
    // unbound it; we collect 404s as informational rather than fatal.
    try {
      await retell.phoneNumber.delete(n.phone_number);
      console.log(`[${logTag}] removed Retell phone-number binding for ${n.phone_number}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${logTag}] retell.phoneNumber.delete(${n.phone_number}): ${msg}`);
      errors.push(`retell.phoneNumber.delete(${n.phone_number}): ${msg}`);
    }

    // Twilio messaging-service detach (must happen before Twilio release).
    if (config.TWILIO_MESSAGING_SERVICE_SID && n.phone_number_sid) {
      try {
        await twilioClient.messaging.v1
          .services(config.TWILIO_MESSAGING_SERVICE_SID)
          .phoneNumbers(n.phone_number_sid)
          .remove();
        console.log(`[${logTag}] detached ${n.phone_number} from messaging service`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 20404: not found — already detached. Treat as informational.
        if (!/20404|404/.test(msg)) {
          console.warn(`[${logTag}] twilio messaging-service detach (${n.phone_number}): ${msg}`);
          errors.push(`twilio messaging-service detach (${n.phone_number}): ${msg}`);
        }
      }
    }

    // Twilio trunk detach (must happen before Twilio release).
    if (config.TWILIO_TRUNK_SID && n.phone_number_sid) {
      try {
        await twilioClient.trunking.v1
          .trunks(config.TWILIO_TRUNK_SID)
          .phoneNumbers(n.phone_number_sid)
          .remove();
        console.log(`[${logTag}] detached ${n.phone_number} from trunk`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/20404|404/.test(msg)) {
          console.warn(`[${logTag}] twilio trunk detach (${n.phone_number}): ${msg}`);
          errors.push(`twilio trunk detach (${n.phone_number}): ${msg}`);
        }
      }
    }

    // Twilio incoming-number release — STOPS THE RECURRING CHARGE.
    if (n.phone_number_sid) {
      try {
        await twilioClient.incomingPhoneNumbers(n.phone_number_sid).remove();
        console.log(`[${logTag}] released Twilio number ${n.phone_number} (sid=${n.phone_number_sid})`);
        released.push(n);
        // Audit-log the release so getNumberDaysInRange (billing) sees it.
        await logPhoneEvent(slug, n.phone_number, n.phone_number_sid, "released");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${logTag}] twilio release (${n.phone_number}): ${msg}`);
        errors.push(`twilio release (${n.phone_number}): ${msg}`);
      }
    } else {
      // No SID on file — we can't release Twilio. Log a release event with
      // an empty sid so billing reflects the cutoff, but flag it as a gap.
      const note = `no Twilio SID on file for ${n.phone_number} — number not released, may still incur charges`;
      console.warn(`[${logTag}] ${note}`);
      errors.push(note);
    }
  }

  // ── 2. Retell agents + conversation flows ─────────────────────────────────
  const retellAgents = doc.retell_agents ?? {};
  for (const [agentId, agentJson] of Object.entries(retellAgents)) {
    try {
      await retell.agent.delete(agentId);
      console.log(`[${logTag}] deleted Retell agent ${agentId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${logTag}] retell.agent.delete(${agentId}): ${msg}`);
      errors.push(`retell.agent.delete(${agentId}): ${msg}`);
    }
    const flowId =
      (agentJson as Record<string, any>)?.conversationFlow?.conversation_flow_id ??
      (agentJson as Record<string, any>)?.response_engine?.conversation_flow_id;
    if (flowId) {
      try {
        await retell.conversationFlow.delete(flowId);
        console.log(`[${logTag}] deleted Retell flow ${flowId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${logTag}] retell.conversationFlow.delete(${flowId}): ${msg}`);
        errors.push(`retell.conversationFlow.delete(${flowId}): ${msg}`);
      }
    }
  }
  // Belt-and-suspenders: also delete the doc.agent_id if it isn't already
  // covered by the retell_agents map (legacy single-agent shape).
  if (doc.agent_id && !retellAgents[doc.agent_id]) {
    try {
      await retell.agent.delete(doc.agent_id);
      console.log(`[${logTag}] deleted Retell agent ${doc.agent_id} (from doc.agent_id)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${logTag}] retell.agent.delete(${doc.agent_id}): ${msg}`);
      errors.push(`retell.agent.delete(${doc.agent_id}): ${msg}`);
    }
  }

  return { released, errors };
}

/**
 * Returns the phone numbers currently active for a slug, derived from the
 * phone_number_history collection: every `provisioned` event without a
 * subsequent `released` event for the same number.
 */
async function activePhoneNumbersFor(slug: string): Promise<ReleasedPhoneNumber[]> {
  const coll = getDb().collection("phone_number_history");
  const events = await coll
    .find({ client_slug: slug })
    .sort({ phone_number: 1, at: 1 })
    .toArray();

  // Walk each number's timeline; we want the latest state per number.
  const lastEventByNumber = new Map<string, { event: string; sid: string }>();
  for (const ev of events as unknown as Array<{ phone_number: string; phone_number_sid: string; event: string }>) {
    lastEventByNumber.set(ev.phone_number, { event: ev.event, sid: ev.phone_number_sid });
  }

  const active: ReleasedPhoneNumber[] = [];
  for (const [phone_number, state] of lastEventByNumber) {
    if (state.event === "provisioned") {
      active.push({ phone_number, phone_number_sid: state.sid });
    }
  }
  return active;
}
