// One-shot: seed dismissed pending leads for the 16 Meta Lead Ads rows
// that existed in the Sheet before we wired externalId-based dedup.
//
// Why dismissed: we want the next Apps Script run to short-circuit on
// these IDs (so they don't re-flow into the active queue), but they
// shouldn't show up in the operator's list either. status=dismissed
// achieves both — listPendingLeads excludes terminal statuses by default,
// and findPendingLeadByExternalId still finds them for dedup.
//
// Idempotent: re-running this skips IDs that already have a doc.
//
// Run: tsx tools/seed-meta-lead-backfill.ts
//      (env: MONGODB_URL must be set, same as the API uses)

import "dotenv/config";
import { initDb } from "../src/lib/db.js";
import { createPendingLead, findPendingLeadByExternalId } from "../src/lib/pending-leads.js";

const META_LEAD_IDS = [
  "l:1574729760257730",
  "l:2291434694997786",
  "l:1387872000021759",
  "l:2121424968755352",
  "l:1608078050257815",
  "l:2110088586201496",
  "l:978639401248342",
  "l:2051723285740786",
  "l:1952370332314670",
  "l:1707132333732098",
  "l:1462225748721044",
  "l:1611217296823291",
  "l:1646328269972722",
  "l:1982239262383538",
  "l:2094266304516155",
  "l:1520916333033912",
];

async function main(): Promise<void> {
  await initDb();

  let created = 0;
  let skipped = 0;
  for (const externalId of META_LEAD_IDS) {
    const existing = await findPendingLeadByExternalId(externalId);
    if (existing) {
      skipped++;
      console.log(`[skip] ${externalId} → already exists (${existing.status})`);
      continue;
    }
    const lead = await createPendingLead({
      source: "meta_lead_ads_backfill",
      input: { name: "(backfill — pre-externalId import)" },
      externalId,
      status: "dismissed",
    });
    created++;
    console.log(`[seed] ${externalId} → ${lead._id} (dismissed)`);
  }

  console.log(`\nDone: ${created} seeded, ${skipped} skipped (already known).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
