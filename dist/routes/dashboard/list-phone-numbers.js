import Retell from "retell-sdk";
import { config } from "../../config.js";
export async function listPhoneNumbersHandler(_req, res) {
    const retell = new Retell({ apiKey: config.RETELL_API_KEY });
    let allNumbers;
    try {
        allNumbers = await retell.phoneNumber.list();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[list-phone-numbers] retell.phoneNumber.list() failed:", msg);
        res.json({ byAgent: {}, error: msg });
        return;
    }
    const byAgent = {};
    for (const n of allNumbers) {
        const phone_number = n.phone_number;
        const nickname = n.nickname ?? null;
        const inboundIds = new Set();
        for (const a of n.inbound_agents ?? []) {
            if (a.agent_id)
                inboundIds.add(a.agent_id);
        }
        for (const id of inboundIds) {
            (byAgent[id] ??= []).push({ phone_number, nickname, role: "inbound" });
        }
        // outbound_agents may not be present on all SDK shapes; access defensively.
        const outboundAgents = n
            .outbound_agents ?? [];
        for (const a of outboundAgents) {
            if (!a.agent_id || inboundIds.has(a.agent_id))
                continue;
            (byAgent[a.agent_id] ??= []).push({ phone_number, nickname, role: "outbound" });
        }
    }
    res.json({ byAgent });
}
