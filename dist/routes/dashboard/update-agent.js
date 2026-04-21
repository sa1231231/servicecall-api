import { updateClientFields, getClientDocument } from "../../config/client-store.js";
export async function updateAgentHandler(req, res) {
    const slug = req.params.slug;
    const body = req.body;
    if (!body || typeof body !== "object" || Object.keys(body).length === 0) {
        res.status(400).json({ error: "Request body must be a non-empty object" });
        return;
    }
    try {
        await updateClientFields(slug, body);
        const doc = await getClientDocument(slug);
        res.json({ success: true, doc });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const status = message.includes("not found") ? 404 : 400;
        res.status(status).json({ error: message });
    }
}
