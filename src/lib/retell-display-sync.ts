import type Retell from "retell-sdk";

export interface RetellDisplaySyncResult {
  agentNameUpdated: boolean;
  nicknameUpdated: string[];
  nicknameErrors: string[];
}

// Push a display label to Retell's agent_name and to the nicknames of every
// phone number bound to this agent (inbound binding + outbound_from_number
// fallback). Per-number failures don't abort — the agent.update may have
// already succeeded, so we collect errors and surface them to the caller
// rather than rolling back.
export async function syncRetellDisplayLabels(
  retellClient: Retell,
  agentId: string,
  outboundFromNumber: string | null | undefined,
  label: string,
): Promise<RetellDisplaySyncResult> {
  const result: RetellDisplaySyncResult = {
    agentNameUpdated: false,
    nicknameUpdated: [],
    nicknameErrors: [],
  };

  await retellClient.agent.update(agentId, { agent_name: label } as any);
  result.agentNameUpdated = true;

  try {
    const allNumbers = await retellClient.phoneNumber.list();
    const matching = allNumbers.filter((n) => {
      if (n.inbound_agents?.some((a) => a.agent_id === agentId)) return true;
      if (outboundFromNumber && n.phone_number === outboundFromNumber) return true;
      return false;
    });
    for (const num of matching) {
      try {
        await retellClient.phoneNumber.update(num.phone_number, { nickname: label } as any);
        result.nicknameUpdated.push(num.phone_number);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[retell-display-sync] failed to update nickname on ${num.phone_number}: ${msg}`);
        result.nicknameErrors.push(`${num.phone_number}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[retell-display-sync] failed to list phone numbers: ${msg}`);
    result.nicknameErrors.push(`list: ${msg}`);
  }

  return result;
}
