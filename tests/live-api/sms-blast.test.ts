import { describe, it, expect, afterAll } from "vitest";
import { hasFullEnv } from "./lib/env.js";
import { apiFetch, apiPost } from "./lib/api-client.js";
import { sweepActiveFixtures } from "./fixtures/agent.js";

// SMS Blast — PREVIEW ONLY.
//
// We deliberately do NOT exercise POST /blast-sms in production, even
// though the route is gated by a confirm token. The blast endpoint
// sends to *all* active non-shadow clients, which in production means
// every real customer's phone. Even with the confirm-recipients drift
// guard, sending to real customers as a side effect of running a test
// would be catastrophic.
//
// The preview endpoint counts recipients without sending and is safe
// to exercise live. The full send path is covered by mocked unit
// tests in src/routes/dashboard/__tests__/blast-sms-routes.test.ts.

describe.skipIf(!hasFullEnv)(
  "[live-api] sms_blast (preview only)",
  { timeout: 60_000 },
  () => {
    afterAll(async () => {
      const swept = await sweepActiveFixtures();
      if (swept > 0) throw new Error(`Suite-level sweep cleaned up ${swept} fixture(s) — leak detected`);
    });

    it("/blast-sms/preview returns a recipient count without sending", async () => {
      const preview = await apiPost<{ total_recipients: number; total_clients: number; sample_message: string }>(
        "/dashboard/api/blast-sms/preview",
        { message: "Test message {{client_name}}" },
      );
      expect(typeof preview.total_recipients).toBe("number");
      expect(typeof preview.total_clients).toBe("number");
      expect(typeof preview.sample_message).toBe("string");
      // The sample message should have substituted {{client_name}} for some real client name.
      expect(preview.sample_message).not.toContain("{{client_name}}");
    });

    it("/blast-sms (no confirm) returns 400 — gate is wired", async () => {
      const r = await apiFetch("/dashboard/api/blast-sms", {
        method: "POST",
        body: { message: "hi" },
        expectError: true,
      });
      expect(r.status).toBe(400);
    });

    it("/blast-sms (with confirm but bogus recipient count) returns 409 — drift gate is wired", async () => {
      const r = await apiFetch("/dashboard/api/blast-sms", {
        method: "POST",
        body: { message: "hi", confirm: true, confirm_recipients: 999_999 },
        expectError: true,
      });
      expect(r.status).toBe(409);
    });
  },
);
