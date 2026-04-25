import { Router } from "express";
import { runWeeklyReports } from "../../lib/weekly-report.js";
export const reportsRouter = Router();
reportsRouter.post("/weekly", async (req, res) => {
    const clientId = req.query.client_id;
    try {
        const result = await runWeeklyReports(clientId || undefined);
        res.json({ success: true, ...result });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("[reports] weekly report error:", message);
        res.status(500).json({ error: message });
    }
});
