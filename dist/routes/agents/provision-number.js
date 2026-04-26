import { getClientDocument, updateClientField } from "../../config/client-store.js";
import { provisionPhoneNumber } from "../../lib/provision-number.js";
export async function provisionNumberHandler(req, res) {
    const { slug } = req.body;
    if (!slug) {
        res.status(400).json({ error: "Missing required field: slug" });
        return;
    }
    const doc = await getClientDocument(slug);
    if (!doc) {
        res.status(404).json({ error: `Client "${slug}" not found` });
        return;
    }
    const agentId = doc.agent_ids?.[0];
    if (!agentId) {
        res.status(400).json({ error: `Client "${slug}" has no agent_ids` });
        return;
    }
    const dispatchCallNumber = doc.dispatch_call_number;
    if (!dispatchCallNumber) {
        res.status(400).json({ error: `Client "${slug}" has no dispatch_call_number to derive area code from` });
        return;
    }
    try {
        const result = await provisionPhoneNumber({
            agentId,
            clientName: doc.name,
            dispatchCallNumber,
        });
        await updateClientField(slug, "outbound_from_number", result.phoneNumber);
        res.json({
            success: true,
            phone_number: result.phoneNumber,
            phone_number_sid: result.phoneNumberSid,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error(`[provision-number] error for "${slug}":`, message);
        res.status(502).json({ error: "Phone number provisioning failed", details: message });
    }
}
