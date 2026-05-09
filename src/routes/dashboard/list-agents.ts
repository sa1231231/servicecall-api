import type { Request, Response } from "express";
import { getAllClientDocuments } from "../../config/client-store.js";
import { getMtdCogsForAllClients } from "../../lib/billing-cogs.js";
import { getDb } from "../../lib/db.js";

const DRIFT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Aggregate the most recent `auto_sync` drift snapshot per slug within the
// last 24h. Returns a map { slug → ISO timestamp }. Best-effort: any failure
// here yields an empty map so the agent list still renders.
async function getRecentDriftBySlug(): Promise<Record<string, string>> {
  try {
    const cutoff = new Date(Date.now() - DRIFT_WINDOW_MS);
    const docs = await getDb()
      .collection("agent_versions")
      .aggregate([
        {
          $match: {
            source: "auto_sync",
            description: "Auto-sync drift detected",
            createdAt: { $gte: cutoff },
          },
        },
        { $group: { _id: "$slug", lastDriftAt: { $max: "$createdAt" } } },
      ])
      .toArray();
    const out: Record<string, string> = {};
    for (const d of docs) {
      const ts = d.lastDriftAt instanceof Date ? d.lastDriftAt : new Date(d.lastDriftAt);
      out[d._id as string] = ts.toISOString();
    }
    return out;
  } catch (err) {
    console.error("[list-agents] drift aggregation failed:", err instanceof Error ? err.message : err);
    return {};
  }
}

export async function listAgentsHandler(_req: Request, res: Response): Promise<void> {
  const docs = await getAllClientDocuments();
  const [mtdBySlug, driftBySlug] = await Promise.all([
    getMtdCogsForAllClients().catch((err) => {
      console.error("[list-agents] MTD COGS aggregation failed:", err.message);
      return {} as Record<string, number>;
    }),
    getRecentDriftBySlug(),
  ]);
  const summaries = docs.map((doc) => ({
    slug: doc._id,
    name: doc.name,
    display_name: doc.display_name ?? null,
    shadow_mode: doc.shadow_mode ?? false,
    active: doc.active,
    agent_id: doc.agent_id,
    trial_start_date: doc.trial_start_date ?? null,
    mtd_cogs_cents: mtdBySlug[doc._id] ?? 0,
    folder_id: doc.folder_id ?? null,
    outbound_from_number: doc.outbound_from_number ?? null,
    drift_detected_at: driftBySlug[doc._id] ?? null,
    // Surface the client POC name so the agent list can show a toggleable
    // "Client name" column. Stored flat on the JsonClientEntry (the API
    // accepts CreateAgentBody.client.contact_name nested, but agent-from-config
    // unnests it into the top-level field — see agent-from-config.ts:315).
    contact_name: doc.contact_name ?? null,
  }));
  res.json(summaries);
}
