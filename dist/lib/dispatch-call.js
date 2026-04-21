import Retell from "retell-sdk";
import { config } from "../config.js";
const retell = new Retell({ apiKey: config.RETELL_API_KEY });
export async function triggerDispatchCall(clientConfig, dynamicVars) {
    const { dispatch_call_number, summary_agent_id, outbound_from_number } = clientConfig;
    if (!dispatch_call_number || !summary_agent_id || !outbound_from_number) {
        return;
    }
    try {
        const response = await retell.call.createPhoneCall({
            from_number: outbound_from_number,
            to_number: dispatch_call_number,
            override_agent_id: summary_agent_id,
            retell_llm_dynamic_variables: dynamicVars,
        });
        console.log(`dispatch-call: created | call_id=${response.call_id} | client="${clientConfig.name}" | to=${dispatch_call_number}`);
    }
    catch (err) {
        console.error(`dispatch-call: failed | client="${clientConfig.name}" | to=${dispatch_call_number} | error=${err.message}`);
    }
}
