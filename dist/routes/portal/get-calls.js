import { getCallLogsByClient } from "../../lib/call-log.js";
export async function portalGetCallsHandler(req, res) {
    const slug = req.portalSlug;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    try {
        const calls = await getCallLogsByClient(slug, limit, offset);
        // Filter out shadow/test calls and strip internal fields
        const sanitized = calls
            .filter((c) => c.outcome !== "shadow_dry_run")
            .filter((c) => c.from_number && c.from_number !== "unknown" && c.from_number !== "Web Call")
            .map((c) => ({
            _id: c._id,
            from_number: c.from_number,
            duration_ms: c.duration_ms,
            outcome: c.outcome,
            extracted_fields: c.extracted_fields,
            message_type_label: c.message_type_label,
            call_summary: c.call_summary,
            user_sentiment: c.user_sentiment,
            recording_url: c.recording_url,
            created_at: c.created_at,
        }));
        res.json(sanitized);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: message });
    }
}
