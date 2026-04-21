import { getClientDocument } from "../../config/client-store.js";
export async function getAgentHandler(req, res) {
    const slug = req.params.slug;
    try {
        const doc = await getClientDocument(slug);
        if (!doc) {
            res.status(404).json({ error: `Client "${slug}" not found` });
            return;
        }
        res.json(doc);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: message });
    }
}
