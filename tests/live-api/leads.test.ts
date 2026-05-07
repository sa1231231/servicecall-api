import { describe, it, expect, afterAll } from "vitest";
import { hasFullEnv, getLiveEnv } from "./lib/env.js";
import { apiFetch, apiGet, apiPost } from "./lib/api-client.js";
import { sweepActiveFixtures } from "./fixtures/agent.js";

// Pending leads — intake → enrichment → dismiss.
//
// The promote → agent step is intentionally skipped in this suite:
// promotion requires a saved draft (loadDraft) and produces a fully
// provisioned Retell + Twilio agent — both expensive to set up and
// expensive to clean up. The createTestAgent fixture exercises the
// same provisioning code path more cleanly. This test focuses on the
// uniquely-leads parts: bearer-token intake, async LLM enrichment,
// status polling, dismiss.

const ENRICHMENT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2000;

describe.skipIf(!hasFullEnv)(
  "[live-api] pending_leads (intake → enrichment → dismiss)",
  { timeout: 120_000 },
  () => {
    const dismissedIds: string[] = [];

    afterAll(async () => {
      // Dismiss any leads we created (idempotent — already-dismissed is fine).
      for (const id of dismissedIds) {
        await apiFetch(`/api/leads/${id}/dismiss`, { method: "POST", expectError: true }).catch(() => {});
      }
      const swept = await sweepActiveFixtures();
      if (swept > 0) throw new Error(`Suite-level sweep cleaned up ${swept} fixture(s) — leak detected`);
    });

    it("rejects bearer-less intake with 401", async () => {
      const env = getLiveEnv();
      // Direct fetch, no bearer.
      const r = await fetch(`${env.baseURL}/api/leads/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "no-token" }),
      });
      expect(r.status).toBe(401);
    });

    it.skipIf(!getLiveEnv().leadIntakeToken)(
      "intake → enrichment → dismiss (full async flow)",
      async () => {
        const env = getLiveEnv();
        const slug = `e2e-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(16).slice(2, 8)}`;
        const business = `E2E Test Lead ${slug.slice(-6)}`;
        // 1. Intake via bearer-authed endpoint.
        const intakeResp = await fetch(`${env.baseURL}/api/leads/intake`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.leadIntakeToken}`,
          },
          body: JSON.stringify({
            name: business,
            phone: "+15551234567",
            website: "https://example.com",
            source: "e2e-test",
          }),
        });
        expect(intakeResp.status).toBe(201);
        const intake = await intakeResp.json() as { _id: string; status: string };
        expect(typeof intake._id).toBe("string");
        dismissedIds.push(intake._id);

        // 2. Poll until status leaves "enriching".
        let lead: { status: string; enriched?: { business_name?: string }; enrichmentError?: string } | null = null;
        const startedAt = Date.now();
        while (Date.now() - startedAt < ENRICHMENT_TIMEOUT_MS) {
          lead = await apiGet(`/api/leads/${intake._id}`);
          if (lead && lead.status !== "enriching") break;
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        expect(lead, "lead never finished enriching").not.toBeNull();
        // Either "ready" (enrichment succeeded) or "failed" is acceptable —
        // we're not testing the LLM's quality here, just that the pipeline
        // ran. A perpetual "enriching" state means the background job
        // wasn't kicked off.
        expect(["ready", "failed"]).toContain(lead!.status);

        // 3. Lead appears in the list endpoint (dashboard auth).
        const list = await apiGet<Array<{ _id: string }>>("/api/leads");
        expect(list.some((l) => l._id === intake._id)).toBe(true);

        // 4. Dismiss.
        const dismissed = await apiPost<{ success: boolean }>(`/api/leads/${intake._id}/dismiss`);
        expect(dismissed.success).toBe(true);
      },
    );
  },
);
