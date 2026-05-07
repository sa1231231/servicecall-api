import Twilio from "twilio";
import { config } from "../config.js";
import { lookupSidFromHistory } from "./phone-number-history.js";
// Push a display label to Retell's agent_name, to the nicknames of every
// phone number bound to this agent (inbound binding + outbound_from_number
// fallback), AND to the matching Twilio incoming-phone-number friendlyName
// for each number. Per-number failures don't abort — the agent.update may
// have already succeeded, so we collect errors and surface them to the
// caller rather than rolling back.
//
// `slug` is needed to look up Twilio SIDs from phone_number_history; Retell
// doesn't surface SIDs.
export async function syncRetellDisplayLabels(retellClient, slug, agentId, outboundFromNumber, label) {
    const result = {
        agentNameUpdated: false,
        nicknameUpdated: [],
        nicknameErrors: [],
        friendlyNameUpdated: [],
        friendlyNameErrors: [],
    };
    await retellClient.agent.update(agentId, { agent_name: label });
    result.agentNameUpdated = true;
    let matching = [];
    try {
        const allNumbers = await retellClient.phoneNumber.list();
        matching = allNumbers.filter((n) => {
            if (n.inbound_agents?.some((a) => a.agent_id === agentId))
                return true;
            if (outboundFromNumber && n.phone_number === outboundFromNumber)
                return true;
            return false;
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[retell-display-sync] failed to list phone numbers: ${msg}`);
        result.nicknameErrors.push(`list: ${msg}`);
        return result;
    }
    // Twilio client is built lazily — only constructed if there are bindings to
    // update — so the function still works in environments without Twilio
    // credentials configured (just won't touch friendlyName).
    const twilioClient = matching.length > 0
        ? Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN)
        : null;
    for (const num of matching) {
        // 1. Retell nickname
        try {
            await retellClient.phoneNumber.update(num.phone_number, { nickname: label });
            result.nicknameUpdated.push(num.phone_number);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[retell-display-sync] failed to update nickname on ${num.phone_number}: ${msg}`);
            result.nicknameErrors.push(`${num.phone_number}: ${msg}`);
            // Skip the Twilio update if Retell side failed — keeping them in sync
            // means we'd have drifted otherwise.
            continue;
        }
        // 2. Twilio friendlyName — needs the SID, which only phone_number_history
        // knows. If we have no record (legacy number provisioned before history
        // was logged, or never provisioned through us), surface a warning so the
        // operator sees the gap.
        if (!twilioClient)
            continue;
        const sid = await lookupSidFromHistory(slug, num.phone_number);
        if (!sid) {
            const note = `${num.phone_number}: no Twilio SID on file — friendlyName not updated`;
            console.warn(`[retell-display-sync] ${note}`);
            result.friendlyNameErrors.push(note);
            continue;
        }
        try {
            await twilioClient.incomingPhoneNumbers(sid).update({ friendlyName: label });
            result.friendlyNameUpdated.push(num.phone_number);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[retell-display-sync] failed to update Twilio friendlyName on ${num.phone_number}: ${msg}`);
            result.friendlyNameErrors.push(`${num.phone_number}: ${msg}`);
        }
    }
    return result;
}
