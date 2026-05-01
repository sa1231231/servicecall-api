import type { Request, Response } from "express";
import { getAllClientDocuments } from "../../config/client-store.js";
import { getMtdCogsForAllClients } from "../../lib/billing-cogs.js";

export async function listAgentsHandler(_req: Request, res: Response): Promise<void> {
  const docs = await getAllClientDocuments();
  const mtdBySlug = await getMtdCogsForAllClients().catch((err) => {
    console.error("[list-agents] MTD COGS aggregation failed:", err.message);
    return {} as Record<string, number>;
  });
  const summaries = docs.map((doc) => ({
    slug: doc._id,
    name: doc.name,
    shadow_mode: doc.shadow_mode ?? false,
    active: doc.active,
    agent_ids: doc.agent_ids,
    trial_start_date: doc.trial_start_date ?? null,
    mtd_cogs_cents: mtdBySlug[doc._id] ?? 0,
  }));
  res.json(summaries);
}
