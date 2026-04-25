import { getClientDocument } from "../../config/client-store.js";
import { ownerConfig } from "../../config/notification-clients.js";
export async function portalGetAgentHandler(req, res) {
    const slug = req.portalSlug;
    try {
        const doc = await getClientDocument(slug);
        if (!doc) {
            res.status(404).json({ error: "Agent not found" });
            return;
        }
        // Return only client-safe fields, strip owner phone/email
        const textNumbers = (doc.dispatch_text_numbers || []).filter((n) => n !== ownerConfig.phone);
        const emails = (doc.dispatch_email || []).filter((e) => e !== ownerConfig.email);
        const callNumber = doc.dispatch_call_number === ownerConfig.phone ? null : doc.dispatch_call_number;
        const cc = doc.dispatch_cc === ownerConfig.email ? null : doc.dispatch_cc;
        res.json({
            name: doc.name,
            shadow_mode: doc.shadow_mode ?? false,
            dispatch_text_numbers: textNumbers,
            dispatch_call_number: callNumber,
            dispatch_email: emails.length > 0 ? emails : null,
            dispatch_cc: cc,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: message });
    }
}
