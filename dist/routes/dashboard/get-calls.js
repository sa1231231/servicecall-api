import { getCallLogsByClient } from "../../lib/call-log.js";
export async function getCallsHandler(req, res) {
    const slug = req.params.slug;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    try {
        const calls = await getCallLogsByClient(slug, limit, offset);
        res.json(calls);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: message });
    }
}
