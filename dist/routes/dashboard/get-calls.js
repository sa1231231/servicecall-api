import { getCallLogsByClient } from "../../lib/call-log.js";
export async function getCallsHandler(req, res) {
    const slug = req.params.slug;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const includeTests = req.query.include_tests === "1" || req.query.include_tests === "true";
    try {
        const calls = await getCallLogsByClient(slug, limit, offset, { includeTests });
        res.json(calls);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: message });
    }
}
