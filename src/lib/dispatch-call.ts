import Retell from "retell-sdk";
import { config } from "../config.js";
import type { ClientNotificationConfig } from "../config/notification-clients.js";

const retell = new Retell({ apiKey: config.RETELL_API_KEY });

/**
 * Look up the phone number bound to an agent (outbound or inbound).
 * Returns the E.164 number string, or null if none found.
 */
async function resolveAgentPhoneNumber(agentId: string): Promise<string | null> {
  const numbers = await retell.phoneNumber.list();
  for (const n of numbers) {
    if (n.outbound_agents?.some((a) => a.agent_id === agentId)) return n.phone_number;
    if (n.inbound_agents?.some((a) => a.agent_id === agentId)) return n.phone_number;
  }
  return null;
}

export async function triggerDispatchCall(
  clientConfig: ClientNotificationConfig,
  dynamicVars: Record<string, string>,
): Promise<void> {
  const { dispatch_call_number, summary_agent_id } = clientConfig;

  if (!dispatch_call_number || !summary_agent_id) {
    return;
  }

  try {
    const fromNumber = await resolveAgentPhoneNumber(summary_agent_id);
    if (!fromNumber) {
      console.warn(
        `dispatch-call: skipped | client="${clientConfig.name}" | summary agent ${summary_agent_id} has no associated phone number`,
      );
      return;
    }

    const response = await retell.call.createPhoneCall({
      from_number: fromNumber,
      to_number: dispatch_call_number,
      override_agent_id: summary_agent_id,
      retell_llm_dynamic_variables: dynamicVars,
    });
    console.log(
      `dispatch-call: created | call_id=${response.call_id} | client="${clientConfig.name}" | from=${fromNumber} | to=${dispatch_call_number}`,
    );
  } catch (err: any) {
    console.error(
      `dispatch-call: failed | client="${clientConfig.name}" | to=${dispatch_call_number} | error=${err.message}`,
    );
  }
}
