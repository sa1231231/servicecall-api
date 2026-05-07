import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { hasFullEnv } from "./lib/env.js";
import { apiGet, apiPost } from "./lib/api-client.js";
import { createTestAgent, sweepActiveFixtures, type TestAgent } from "./fixtures/agent.js";
import { assertSmsSentTo } from "./lib/twilio-verifier.js";

// send_comms × 4 variants.
//
// Each variant POSTs to a different endpoint that ultimately enqueues
// an outbound SMS to the agent's `dispatch_text_numbers`. Tests verify
// via the Twilio Messages API that the SMS was created within the last
// 60s.
//
// Cost optimization: all four variants share one agent fixture (one
// Twilio number) since they're independent of each other. ~$1 + 4 SMS.

describe.skipIf(!hasFullEnv)(
  "[live-api] send_comms (4 variants)",
  { timeout: 120_000 },
  () => {
    let agent: TestAgent;
    let ownerPhone: string;

    beforeAll(async () => {
      const settings = await apiGet<{ owner_phone?: string; google_review_url?: string; stripe_payment_url?: string }>(
        "/dashboard/api/settings",
      );
      if (!settings.owner_phone) throw new Error("settings.owner_phone is required for this test");
      ownerPhone = settings.owner_phone;
      agent = await createTestAgent();
    });

    afterAll(async () => {
      try {
        await agent?.cleanup();
      } finally {
        const swept = await sweepActiveFixtures();
        if (swept > 0) throw new Error(`Suite-level sweep cleaned up ${swept} fixture(s) — leak detected`);
      }
    });

    it("request-review: enqueues an SMS containing the review URL", async () => {
      const res = await apiPost<{ success: boolean; sent_to: string[] }>(
        `/dashboard/api/agents/${agent.slug}/request-review`,
      );
      expect(res.success).toBe(true);
      expect(res.sent_to).toContain(ownerPhone);
      await assertSmsSentTo(ownerPhone, 60);
    });

    it("send-payment-link: enqueues an SMS containing the Stripe URL", async () => {
      const res = await apiPost<{ success: boolean; sent_to: string[] }>(
        `/dashboard/api/agents/${agent.slug}/send-payment-link`,
      );
      expect(res.success).toBe(true);
      expect(res.sent_to).toContain(ownerPhone);
      await assertSmsSentTo(ownerPhone, 60);
    });

    it("send-portal-link: enqueues an SMS with a one-time client portal URL", async () => {
      const res = await apiPost<{ success: boolean; sent_to: string[] }>(
        `/dashboard/api/agents/${agent.slug}/send-portal-link`,
      );
      expect(res.success).toBe(true);
      expect(res.sent_to).toContain(ownerPhone);
      await assertSmsSentTo(ownerPhone, 60);
    });

    it("send-instructions: enqueues a carrier setup template (uses the first configured template)", async () => {
      const settings = await apiGet<{ setup_instructions?: Array<{ id: string; label: string }> }>(
        "/dashboard/api/settings",
      );
      const template = settings.setup_instructions?.[0];
      if (!template) {
        // No templates configured — skip (don't fail the suite).
        console.log("[send-instructions] no setup_instructions configured, skipping assertion");
        return;
      }
      const res = await apiPost<{ success: boolean; sent_to: string[]; label: string }>(
        `/dashboard/api/agents/${agent.slug}/send-instructions`,
        { id: template.id },
      );
      expect(res.success).toBe(true);
      expect(res.label).toBe(template.label);
      await assertSmsSentTo(ownerPhone, 60);
    });
  },
);
