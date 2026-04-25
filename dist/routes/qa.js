import { Router, json } from "express";
import Retell from "retell-sdk";
import { config } from "../config.js";
import { getClientDocument } from "../config/client-store.js";
import { runSmokeTest, buildSyntheticVariables } from "../lib/qa-smoke.js";
export const qaRouter = Router();
qaRouter.use(json());
qaRouter.post("/smoke/:slug", async (req, res) => {
    const { slug } = req.params;
    const notify = req.query.notify === "true";
    const clientDoc = await getClientDocument(slug);
    if (!clientDoc) {
        res.status(404).json({ error: `Client '${slug}' not found` });
        return;
    }
    if (clientDoc.agent_ids.length === 0) {
        res.status(400).json({ error: `Client '${slug}' has no agent_ids` });
        return;
    }
    try {
        const retell = new Retell({ apiKey: config.RETELL_API_KEY });
        const report = await runSmokeTest(retell, clientDoc, {
            notify,
            postHookUrl: `${req.protocol}://${req.get("host")}/retell/post-hook`,
        });
        res.json(report);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[qa/smoke] unhandled error for slug="${slug}":`, msg);
        res.status(500).json({ error: msg });
    }
});
qaRouter.post("/test-notify/:slug", async (req, res) => {
    const { slug } = req.params;
    const clientDoc = await getClientDocument(slug);
    if (!clientDoc) {
        res.status(404).json({ error: `Client '${slug}' not found` });
        return;
    }
    const agentId = clientDoc.agent_ids[0];
    if (!agentId) {
        res.status(400).json({ error: `Client '${slug}' has no agent_ids` });
        return;
    }
    try {
        const syntheticVars = buildSyntheticVariables(clientDoc);
        const postHookUrl = `${req.protocol}://${req.get("host")}/retell/post-hook`;
        const resp = await fetch(postHookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": config.API_KEY,
            },
            body: JSON.stringify({
                event: "call_ended",
                call: {
                    call_id: `test-notify-${Date.now()}`,
                    agent_id: agentId,
                    from_number: "+15550000000",
                    duration_ms: 30000,
                    disconnection_reason: "agent_hangup",
                    collected_dynamic_variables: syntheticVars,
                    retell_llm_dynamic_variables: {},
                },
            }),
        });
        const body = await resp.json();
        if (!resp.ok) {
            res.status(resp.status).json({ success: false, error: body.message ?? body.errors ?? "Post-hook failed" });
            return;
        }
        console.log(`[qa/test-notify] fired for slug="${slug}" outcome=${body.outcome ?? "dispatched"}`);
        res.json({
            success: true,
            outcome: body.outcome ?? "dispatched",
            shadow_mode: clientDoc.shadow_mode ?? false,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[qa/test-notify] unhandled error for slug="${slug}":`, msg);
        res.status(500).json({ error: msg });
    }
});
