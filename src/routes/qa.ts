import { Router, json } from "express";
import Retell from "retell-sdk";
import { config } from "../config.js";
import { getClientDocument } from "../config/client-store.js";
import { runSmokeTest } from "../lib/qa-smoke.js";

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[qa/smoke] unhandled error for slug="${slug}":`, msg);
    res.status(500).json({ error: msg });
  }
});
