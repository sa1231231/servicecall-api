// One-off: re-create demo-hvac from the HVAC Default draft so its router-edge
// order matches the draft's authoring order.
//
// Background: the live demo-hvac agent's `service_call` path has its router
// edges + front Extract variables in REVERSE order (preferred_day, preferred_time,
// street_address, problem_description, phone_number, full_name, email). The
// HVAC Default draft + generator both emit forward order, but at some point
// the agent's edges got flipped and every dashboard save has been preserving
// the reversal. The other paths (emergency_call, existing_customer) are fine.
//
// Repair: hard-delete the demo-hvac client/agent/flow, then re-instantiate
// from the HVAC Default draft via /agents/from-draft pinning the same slug
// and businessName / FAQ. Backs up the existing client doc to a local JSON
// file before deleting so any per-agent state (FT tweaks, branch conditions,
// dispatch settings) can be reviewed or hand-merged after.
//
// Run:
//   # dry-run (default): print plan, fetch current state, exit
//   railway run npx tsx tools/recreate-demo-hvac-from-draft.ts
//
//   # apply:
//   BASE_URL=https://servicecall-api-production.up.railway.app \
//     API_KEY=... ROOT_PASSWORD=... \
//     railway run npx tsx tools/recreate-demo-hvac-from-draft.ts --apply
//
// Requires both Mongo access (MONGODB_URL via railway) AND HTTP access to
// the running API (BASE_URL + API_KEY + ROOT_PASSWORD).

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { initDb, getDb } from "../src/lib/db.js";

const SLUG = "demo-hvac";
const DRAFT_NAME = "HVAC Default";

function parseFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function parseArg(name: string): string | null {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(name.length + 3) : null;
}

function authHeaders(): Record<string, string> {
  const apiKey = process.env.API_KEY;
  const rootPwd = process.env.ROOT_PASSWORD;
  if (!apiKey) throw new Error("API_KEY env var required");
  if (!rootPwd) throw new Error("ROOT_PASSWORD env var required");
  return {
    "x-api-key": apiKey,
    "Authorization": "Basic " + Buffer.from(`admin:${rootPwd}`).toString("base64"),
    "Content-Type": "application/json",
  };
}

async function main() {
  const apply = parseFlag("apply");
  const baseUrl = parseArg("base-url") || process.env.BASE_URL || process.env.SYSTEM_TEST_URL;
  if (apply && !baseUrl) {
    console.error("--apply requires BASE_URL (or --base-url=) and API_KEY + ROOT_PASSWORD env vars");
    process.exit(1);
  }

  await initDb();
  const db = getDb();

  // ── 1. Fetch current state ─────────────────────────────────────────────
  const doc: any = await db.collection("clients").findOne({ _id: SLUG } as any);
  if (!doc) {
    console.error(`No client doc for slug "${SLUG}". Aborting — nothing to recreate.`);
    process.exit(1);
  }
  const draft: any = await db
    .collection("agent_drafts")
    .find({ name: DRAFT_NAME })
    .sort({ updatedAt: -1 })
    .limit(1)
    .next();
  if (!draft) {
    console.error(`No draft "${DRAFT_NAME}" found. Aborting.`);
    process.exit(1);
  }

  // ── 2. Print plan ──────────────────────────────────────────────────────
  const businessName: string = doc.name ?? "Demo HVAC";
  // The new agent inherits faqKnowledgeBase from the draft's exportConfig.
  // business.faqKnowledgeBase — required by /agents/from-draft. Pull from
  // the draft so we can pass it through; falls back to the current agent's
  // FAQ if the draft doesn't carry one.
  const draftFaq: string = draft.exportConfig?.business?.faqKnowledgeBase ?? "";
  const currentFaq: string = (() => {
    const flow = doc.retell_agents?.[doc.agent_id]?.conversationFlow;
    const faqNode = flow?.nodes?.find((n: any) =>
      typeof n.name === "string" && /^Admin\/FAQ/.test(n.name),
    );
    const text = faqNode?.instruction?.text ?? "";
    const prefix = "Your goal is to answer administrative and general questions briefly and accurately.\n\n";
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  })();
  const faqKnowledgeBase = draftFaq || currentFaq;

  console.log(JSON.stringify({
    slug: SLUG,
    current_agent_id: doc.agent_id,
    business_name: businessName,
    display_name: doc.display_name,
    faq_source: draftFaq ? "draft" : "live agent",
    faq_preview: faqKnowledgeBase.slice(0, 120) + (faqKnowledgeBase.length > 120 ? "..." : ""),
    draft_paths: (draft.exportConfig?.paths ?? []).map((p: any) => ({
      name: p.name,
      dataPoints: (p.dataPoints ?? []).map((dp: any) =>
        typeof dp === "string" ? dp : (dp?._ref ?? dp?.variableName ?? "?"),
      ),
    })),
  }, null, 2));

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to:");
    console.log(`  1. Back up current "${SLUG}" client doc to clients_backup_<ts>.json`);
    console.log(`  2. DELETE /dashboard/api/agents/${SLUG}        (soft-delete)`);
    console.log(`  3. DELETE /dashboard/api/deleted-agents/${SLUG} (permanent, releases Retell + Twilio)`);
    console.log(`  4. POST   /agents/from-draft                   (re-instantiate)`);
    console.log(`  5. GET    /dashboard/api/agents/${SLUG}/nodes/<new_agent_id> (verify order)`);
    process.exit(0);
  }

  // ── 3. Apply ───────────────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `/tmp/clients_backup_${SLUG}_${ts}.json`;
  writeFileSync(backupPath, JSON.stringify(doc, null, 2));
  console.log(`\n[1/5] Backed up current client doc → ${backupPath}`);

  const softResp = await fetch(`${baseUrl}/dashboard/api/agents/${SLUG}`, {
    method: "DELETE", headers: authHeaders(),
  });
  if (!softResp.ok) {
    console.error(`[2/5] Soft-delete failed: ${softResp.status} ${await softResp.text()}`);
    process.exit(1);
  }
  console.log(`[2/5] Soft-deleted "${SLUG}" (resp ${softResp.status})`);

  const hardResp = await fetch(`${baseUrl}/dashboard/api/deleted-agents/${SLUG}`, {
    method: "DELETE", headers: authHeaders(),
  });
  if (!hardResp.ok) {
    console.error(`[3/5] Permanent-delete failed: ${hardResp.status} ${await hardResp.text()}`);
    console.error(`Restore manually with: POST /dashboard/api/deleted-agents/${SLUG}/restore`);
    process.exit(1);
  }
  console.log(`[3/5] Permanent-deleted "${SLUG}" — Retell + Twilio resources released`);

  const fromDraftBody = {
    draft: DRAFT_NAME,
    business: { businessName, faqKnowledgeBase },
    client: {
      slug: SLUG,
      name: businessName,
      // Carry forward operator-set fields that are NOT in the draft's
      // exportConfig.client. Anything missing here just gets defaulted by
      // createAgentFromConfig — re-add later via the dashboard if needed.
      ...(doc.display_name ? { display_name: doc.display_name } : {}),
      ...(doc.dispatch_text_numbers ? { dispatch_text_numbers: doc.dispatch_text_numbers } : {}),
      ...(doc.dispatch_call_number ? { dispatch_call_number: doc.dispatch_call_number } : {}),
      ...(doc.dispatch_email ? { dispatch_email: doc.dispatch_email } : {}),
    },
  };
  const createResp = await fetch(`${baseUrl}/agents/from-draft`, {
    method: "POST", headers: authHeaders(),
    body: JSON.stringify(fromDraftBody),
  });
  if (!createResp.ok) {
    console.error(`[4/5] from-draft failed: ${createResp.status} ${await createResp.text()}`);
    console.error(`Restore from backup: ${backupPath}`);
    process.exit(1);
  }
  const created: any = await createResp.json();
  console.log(`[4/5] Re-instantiated "${SLUG}" → agent_id=${created.agent_id}, flow_id=${created.conversation_flow_id}`);

  // ── 4. Verify order ────────────────────────────────────────────────────
  const verifyResp = await fetch(
    `${baseUrl}/dashboard/api/agents/${SLUG}/nodes/${created.agent_id}`,
    { headers: authHeaders() },
  );
  if (!verifyResp.ok) {
    console.error(`[5/5] verify GET failed: ${verifyResp.status}`);
    process.exit(1);
  }
  const state: any = await verifyResp.json();
  console.log(`[5/5] Verification:`);
  for (const path of state.paths) {
    const dps = (path.dataPoints || []).map((dp: any) =>
      dp._action === "sendSms" ? `<sms:${dp.name}>` : dp.variableName,
    );
    console.log(`  ${path.name}: [${dps.join(", ")}]`);
  }

  // Side-by-side diff with the draft so the operator can eyeball it.
  console.log(`\nExpected (from draft):`);
  for (const p of (draft.exportConfig?.paths ?? [])) {
    const dps = (p.dataPoints ?? []).map((dp: any) =>
      typeof dp === "string" ? dp : (dp?._ref ?? dp?.variableName ?? "?"),
    );
    console.log(`  ${p.name}: [${dps.join(", ")}]`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("recreate-demo-hvac-from-draft failed:", err?.stack ?? err);
    process.exit(1);
  });
