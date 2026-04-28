import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

// Use SYSTEM_TEST_URL to avoid collision with Vite's built-in BASE_URL
const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEMO_SLUG = "demo-530e570";

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": API_KEY!,
    "Authorization": basicAuthHeader(),
    "Content-Type": "application/json",
    ...extra,
  };
}

function basicAuthHeader(): string {
  return "Basic " + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString("base64");
}

async function json(resp: Response): Promise<any> {
  return resp.json();
}

// ── Skip all tests if env vars are missing ──────────────────────────────────

const hasConfig = !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY;

describe.skipIf(!hasConfig)("System tests (Railway)", { timeout: 30_000 }, () => {
  // State to restore after mutating tests
  let originalShadowMode: boolean | undefined;
  let originalHideNotMentioned: boolean | undefined;
  let demoAgentId: string | undefined;

  afterAll(async () => {
    // Restore shadow_mode if changed
    if (originalShadowMode !== undefined) {
      await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}/shadow`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ shadow_mode: originalShadowMode }),
      });
    }
    // Restore hide_not_mentioned if changed
    if (originalHideNotMentioned !== undefined) {
      await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ hide_not_mentioned: originalHideNotMentioned }),
      });
    }
  });

  // ── 1. Infrastructure ───────────────────────────────────────────────────

  describe("Infrastructure", () => {
    it("GET /health returns ok", async () => {
      const resp = await fetch(url("/health"));
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });

    it("GET /dashboard/config returns apiKey with Basic Auth", async () => {
      const resp = await fetch(url("/dashboard/config"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.apiKey).toBe("string");
      expect(body.apiKey.length).toBeGreaterThan(0);
    });
  });

  // ── 2. Auth ─────────────────────────────────────────────────────────────

  describe("Auth", () => {
    it("rejects API requests with no API key", async () => {
      const resp = await fetch(url("/dashboard/api/agents"));
      expect(resp.status).toBe(401);
    });

    it("rejects API requests with wrong API key", async () => {
      const resp = await fetch(url("/dashboard/api/agents"), {
        headers: { "x-api-key": "wrong-key" },
      });
      expect(resp.status).toBe(401);
    });

    it("rejects /form/config without Basic Auth", async () => {
      const resp = await fetch(url("/form/config"));
      expect(resp.status).toBe(401);
    });

    it("rejects /dashboard/config without Basic Auth", async () => {
      const resp = await fetch(url("/dashboard/config"));
      expect(resp.status).toBe(401);
    });

    it("rejects /form/config with wrong password", async () => {
      const resp = await fetch(url("/form/config"), {
        headers: { Authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") },
      });
      expect(resp.status).toBe(401);
    });

    it("allows /form/config with correct Basic Auth", async () => {
      const resp = await fetch(url("/form/config"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.apiKey).toBe("string");
    });
  });

  // ── 3. Dashboard API ───────────────────────────────────────────────────

  describe("Dashboard API", () => {
    it("lists agents including demo client", async () => {
      const resp = await fetch(url("/dashboard/api/agents"), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(Array.isArray(body)).toBe(true);

      const demo = body.find((a: any) => a.slug === DEMO_SLUG);
      expect(demo).toBeDefined();
      expect(demo.name).toBeDefined();
      expect(Array.isArray(demo.agent_ids)).toBe(true);
      expect(demo.agent_ids.length).toBeGreaterThan(0);

      // Save agent_id for later tests
      demoAgentId = demo.agent_ids[0];
    });

    it("returns full detail for demo client", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}`), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);

      expect(body._id).toBe(DEMO_SLUG);
      expect(body.name).toBeDefined();
      expect(Array.isArray(body.agent_ids)).toBe(true);
      expect(body.message_types).toBeDefined();
      expect(Object.keys(body.message_types).length).toBeGreaterThan(0);
      expect(Array.isArray(body.dispatch_text_numbers)).toBe(true);
      expect(body.default_message_type).toBeDefined();
      expect(body.message_types[body.default_message_type]).toBeDefined();

      // Capture state for restoration
      originalShadowMode = body.shadow_mode;
      originalHideNotMentioned = body.hide_not_mentioned;
      demoAgentId = body.agent_ids[0];
    });

    it("returns call logs for demo client", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}/calls?limit=5`), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns 404 for nonexistent client", async () => {
      const resp = await fetch(url("/dashboard/api/agents/nonexistent-slug-xyz"), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(404);
    });
  });

  // ── 4. Agent Sync ──────────────────────────────────────────────────────

  describe("Agent sync from Retell", () => {
    it("syncs demo agent from Retell API", async () => {
      const resp = await fetch(url(`/agents/${DEMO_SLUG}/sync`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);

      expect(body.success).toBe(true);
      expect(typeof body.agent_id).toBe("string");
      expect(typeof body.agent_name).toBe("string");
      expect(Array.isArray(body.variables)).toBe(true);
      expect(body.variables.length).toBeGreaterThan(0);

      // Notification config should be present
      expect(body.notification_config).toBeDefined();
    });

    it("demo agent is still valid after sync", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}`), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);

      expect(body._id).toBe(DEMO_SLUG);
      expect(Array.isArray(body.agent_ids)).toBe(true);
      expect(body.agent_ids.length).toBeGreaterThan(0);
      expect(Object.keys(body.message_types).length).toBeGreaterThan(0);
      expect(body.retell_agents).toBeDefined();
    });
  });

  // ── 5. Shadow Mode Toggle ─────────────────────────────────────────────

  describe("Shadow mode toggle", () => {
    it("enables shadow mode", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}/shadow`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ shadow_mode: true }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.shadow_mode).toBe(true);
    });

    it("rejects non-boolean shadow_mode", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}/shadow`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ shadow_mode: "yes" }),
      });
      expect(resp.status).toBe(400);
    });
  });

  // ── 6. Post-hook Shadow Dry-Run ───────────────────────────────────────

  describe("Post-hook (shadow dry-run)", () => {
    it("processes a synthetic call_ended and returns shadow_dry_run", async () => {
      // Ensure shadow mode is on
      await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}/shadow`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ shadow_mode: true }),
      });

      // Need the agent_id — fetch if not already set
      if (!demoAgentId) {
        const agentResp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}`), {
          headers: authHeaders(),
        });
        const agentBody = await json(agentResp);
        demoAgentId = agentBody.agent_ids[0];
      }

      const payload = {
        event: "call_ended",
        call: {
          call_id: `system-test-${Date.now()}`,
          agent_id: demoAgentId,
          from_number: "+15550000000",
          duration_ms: 30000,
          disconnection_reason: "agent_hangup",
          collected_dynamic_variables: {
            full_name: "System Test User",
            phone_number: "555-999-0000",
          },
          retell_llm_dynamic_variables: {},
        },
      };

      const resp = await fetch(url("/retell/post-hook"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      // The post-hook may require Retell signature verification for this agent.
      // If it returns 401, that's expected for non-Test-Client agents.
      if (resp.status === 401) {
        // Signature verification required — test that the endpoint is reachable
        expect(resp.status).toBe(401);
        return;
      }

      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      // Could be shadow_dry_run or skipped_empty_call depending on field config
      expect(["shadow_dry_run", "skipped_empty_call"]).toContain(body.outcome);
    });
  });

  // ── 7. QA Smoke Test ──────────────────────────────────────────────────

  describe("QA smoke test", () => {
    let smokeReport: any;

    it("runs smoke test endpoint successfully", async () => {
      const resp = await fetch(url(`/qa/smoke/${DEMO_SLUG}`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      smokeReport = await json(resp);

      expect(smokeReport.slug).toBe(DEMO_SLUG);
      expect(typeof smokeReport.agent_id).toBe("string");
      expect(typeof smokeReport.duration_ms).toBe("number");

      // Verify all expected checks ran (none skipped)
      const checkNames = smokeReport.checks.map((c: any) => c.check);
      expect(checkNames).toContain("agent_reachable");
      expect(checkNames).toContain("greeting_has_business_name");
      expect(checkNames).toContain("data_points_in_flow");
      expect(checkNames).toContain("notification_config_complete");
      expect(checkNames).toContain("message_type_resolves");
      expect(checkNames).toContain("required_fields_satisfiable");
      expect(smokeReport.summary.skip).toBe(0);
    });

    it("agent is reachable in Retell", () => {
      const check = smokeReport?.checks?.find((c: any) => c.check === "agent_reachable");
      expect(check?.status).toBe("pass");
    });

    it("data points match between flow and notification config", () => {
      const check = smokeReport?.checks?.find((c: any) => c.check === "data_points_in_flow");
      expect(check?.status).toBe("pass");
    });

    it("notification config is complete", () => {
      const check = smokeReport?.checks?.find((c: any) => c.check === "notification_config_complete");
      expect(check?.status).toBe("pass");
    });

    it("message type resolves correctly", () => {
      const check = smokeReport?.checks?.find((c: any) => c.check === "message_type_resolves");
      expect(check?.status).toBe("pass");
    });
  });

  // ── 8. Weekly Reports ────────────────────────────────────────────────

  describe("Weekly reports", () => {
    it("sends a weekly report for a specific client", async () => {
      const resp = await fetch(url(`/api/reports/weekly?client_id=${DEMO_SLUG}`), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(Array.isArray(body.sent)).toBe(true);
      expect(body.sent).toContain(DEMO_SLUG);
    });

    it("returns empty sent for nonexistent client", async () => {
      const resp = await fetch(url("/api/reports/weekly?client_id=nonexistent-xyz"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.sent).toHaveLength(0);
    });

    it("rejects without API key", async () => {
      const resp = await fetch(url("/api/reports/weekly"), {
        method: "POST",
      });
      expect(resp.status).toBe(401);
    });
  });

  // ── 9. Phone Provisioning Endpoint ──────────────────────────────────

  describe("Phone provisioning endpoint", () => {
    it("rejects without slug", async () => {
      const resp = await fetch(url("/agents/provision-number"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      const body = await json(resp);
      expect(body.error).toContain("slug");
    });

    it("returns 404 for nonexistent client", async () => {
      const resp = await fetch(url("/agents/provision-number"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ slug: "nonexistent-xyz" }),
      });
      expect(resp.status).toBe(404);
    });

    it("rejects client without dispatch_call_number", async () => {
      // pro-v has no dispatch_call_number
      const resp = await fetch(url("/agents/provision-number"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ slug: "pro-v" }),
      });
      expect(resp.status).toBe(400);
      const body = await json(resp);
      expect(body.error).toContain("dispatch_call_number");
    });

    it("rejects without API key", async () => {
      const resp = await fetch(url("/agents/provision-number"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: DEMO_SLUG }),
      });
      expect(resp.status).toBe(401);
    });
  });

  // ── 10. Update Agent Fields ────────────────────────────────────────────

  describe("Update agent fields", () => {
    it("updates hide_not_mentioned", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ hide_not_mentioned: true }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.doc.hide_not_mentioned).toBe(true);
    });

    it("rejects non-editable fields", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ retell_agents: {} }),
      });
      expect(resp.status).toBe(400);
    });

    it("rejects empty body", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${DEMO_SLUG}`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });
  });

  // ── 11. Backup Endpoint ──────────────────────────────────────────────

  describe("Backup endpoint", () => {
    it("triggers a backup and returns success", { timeout: 60_000 }, async () => {
      const resp = await fetch(url("/api/backup"), {
        method: "POST",
        headers: authHeaders(),
      });
      // If R2 is configured, expect success; if not, expect 500 with "not configured"
      const body = await json(resp);
      if (resp.status === 200) {
        expect(body.success).toBe(true);
        expect(body.key).toMatch(/^backups\/\d{4}-\d{2}-\d{2}\.json\.gz$/);
      } else {
        expect(resp.status).toBe(500);
        expect(body.error).toContain("R2");
      }
    });

    it("rejects without API key", async () => {
      const resp = await fetch(url("/api/backup"), {
        method: "POST",
      });
      expect(resp.status).toBe(401);
    });
  });

  // ── 12. Settings Endpoint ────────────────────────────────────────────

  describe("Settings", () => {
    it("returns current settings", async () => {
      const resp = await fetch(url("/dashboard/api/settings"), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.owner_email).toBe("string");
      expect(typeof body.owner_phone).toBe("string");
      expect(typeof body.google_review_url).toBe("string");
      expect(typeof body.stripe_payment_url).toBe("string");
    });

    it("rejects without API key", async () => {
      const resp = await fetch(url("/dashboard/api/settings"), {
        headers: { "Content-Type": "application/json" },
      });
      expect(resp.status).toBe(401);
    });
  });

  // ── 13. Portal Endpoint ──────────────────────────────────────────────

  describe("Portal", () => {
    it("serves portal HTML page", async () => {
      const resp = await fetch(url(`/portal/${DEMO_SLUG}`));
      // Portal serves HTML shell — auth handled client-side
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("html");
    });

    it("portal API rejects invalid token", async () => {
      const resp = await fetch(url(`/portal/${DEMO_SLUG}/calls?token=invalid-token`));
      expect(resp.status).toBe(401);
    });
  });

  // ── 14. Transcript Download ──────────────────────────────────────────

  describe("Transcript download", () => {
    it("returns 404 for nonexistent call", async () => {
      const resp = await fetch(
        url(`/dashboard/api/agents/${DEMO_SLUG}/calls/nonexistent-call-id/transcript`),
        { headers: authHeaders() },
      );
      expect(resp.status).toBe(404);
    });
  });

  // ── 15. Review Request ───────────────────────────────────────────────

  describe("Review request", () => {
    it("returns error when Google Review URL is not configured or sends successfully", async () => {
      const resp = await fetch(
        url(`/dashboard/api/agents/${DEMO_SLUG}/request-review`),
        { method: "POST", headers: authHeaders() },
      );
      const body = await json(resp);
      // Either 400 (no URL configured) or 200 (success) — both are valid
      expect([200, 400]).toContain(resp.status);
      if (resp.status === 400) {
        expect(body.error).toContain("Review URL");
      } else {
        expect(body.success).toBe(true);
      }
    });

    it("returns 404 for nonexistent client", async () => {
      const resp = await fetch(
        url("/dashboard/api/agents/nonexistent-slug-xyz/request-review"),
        { method: "POST", headers: authHeaders() },
      );
      expect(resp.status).toBe(404);
    });
  });

  // ── 16. Payment Link ─────────────────────────────────────────────────

  describe("Payment link", () => {
    it("returns error when Stripe URL is not configured or sends successfully", async () => {
      const resp = await fetch(
        url(`/dashboard/api/agents/${DEMO_SLUG}/send-payment-link`),
        { method: "POST", headers: authHeaders() },
      );
      const body = await json(resp);
      expect([200, 400]).toContain(resp.status);
      if (resp.status === 400) {
        expect(body.error).toContain("Payment URL");
      } else {
        expect(body.success).toBe(true);
      }
    });

    it("returns 404 for nonexistent client", async () => {
      const resp = await fetch(
        url("/dashboard/api/agents/nonexistent-slug-xyz/send-payment-link"),
        { method: "POST", headers: authHeaders() },
      );
      expect(resp.status).toBe(404);
    });
  });

  // ── 17. Portal Token ─────────────────────────────────────────────────

  describe("Portal token", () => {
    it("returns portal token status for demo client", async () => {
      const resp = await fetch(
        url(`/dashboard/api/agents/${DEMO_SLUG}/portal-token`),
        { headers: authHeaders() },
      );
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.has_token).toBe("boolean");
    });
  });

  // ── 18. Portal Magic Link ──────────────────────────────────────────

  describe("Portal magic link", () => {
    it("POST /portal/request-link returns success for any email (no enumeration)", async () => {
      const resp = await fetch(url("/portal/request-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nonexistent@example.com" }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.message).toContain("associated with an account");
    });

    it("POST /portal/request-link returns success for empty email", async () => {
      const resp = await fetch(url("/portal/request-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "" }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });

    it("POST /portal/request-link returns success for invalid email", async () => {
      const resp = await fetch(url("/portal/request-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });
  });

  // ── 19. Client Login Page ──────────────────────────────────────────

  describe("Client login page", () => {
    it("GET /client serves login HTML without auth", async () => {
      const resp = await fetch(url("/client"));
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("Client Portal");
      expect(text).toContain("Send Login Link");
    });
  });

  // ── 20. Data Point Defaults API ────────────────────────────────────

  describe("Data point defaults", () => {
    it("GET /dashboard/api/data-point-defaults returns all defaults", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        { headers: authHeaders() },
      );
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body).toBe("object");
      // Should have at least the built-in data points
      expect(body.full_name).toBeDefined();
      expect(body.full_name.label).toBe("Full Name");
      expect(body.phone_number).toBeDefined();
      expect(body.city).toBeDefined();
    });

    it("all built-in data points are present after seeding", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        { headers: authHeaders() },
      );
      const body = await json(resp);
      const expected = [
        "full_name", "phone_number", "email", "street_address", "city",
        "company_name", "scheduling", "truck_number", "driver_name",
        "driver_phone", "breakdown_location", "problem_description",
        "vehicle_type", "vehicle_manufacturer", "vehicle_color",
        "whos_paying", "payment_method",
      ];
      expected.forEach(key => {
        expect(body[key], `${key} should exist`).toBeDefined();
      });
    });

    it("data points have category field", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        { headers: authHeaders() },
      );
      const body = await json(resp);
      expect(body.full_name.category).toBe("general");
      expect(body.truck_number.category).toBe("trucking");
    });

    it("PATCH updates a data point", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults/full_name"),
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ description: "Test description override" }),
        },
      );
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);

      // Verify it persisted
      const getResp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        { headers: authHeaders() },
      );
      const all = await json(getResp);
      expect(all.full_name.description).toBe("Test description override");

      // Reset it back
      await fetch(
        url("/dashboard/api/data-point-defaults/full_name/reset"),
        { method: "POST", headers: authHeaders() },
      );
    });

    it("PATCH returns 404 for nonexistent data point", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults/nonexistent_xyz"),
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ description: "test" }),
        },
      );
      expect(resp.status).toBe(404);
    });

    it("POST /reset restores registry default", async () => {
      // First modify it
      await fetch(
        url("/dashboard/api/data-point-defaults/city"),
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ description: "Temporary change" }),
        },
      );

      // Then reset
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults/city/reset"),
        { method: "POST", headers: authHeaders() },
      );
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.dataPoint.description).not.toBe("Temporary change");
    });

    it("POST /reset returns 404 for non-registry data point", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults/nonexistent_xyz/reset"),
        { method: "POST", headers: authHeaders() },
      );
      expect(resp.status).toBe(404);
    });

    // ── Custom data point CRUD ─────────────────────────────────────

    let createdTestDp = false;

    it("POST creates a custom data point", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            key: "_test_lot_number",
            label: "Test Lot Number",
            category: "custom",
            type: "string",
          }),
        },
      );
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.dataPoint.label).toBe("Test Lot Number");
      expect(body.dataPoint.category).toBe("custom");
      createdTestDp = true;
    });

    it("POST rejects duplicate key", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ key: "full_name", label: "Duplicate" }),
        },
      );
      expect(resp.status).toBe(400);
      const body = await json(resp);
      expect(body.error).toContain("already exists");
    });

    it("POST rejects missing key or label", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ key: "", label: "" }),
        },
      );
      expect(resp.status).toBe(400);
    });

    it("created custom data point appears in GET", async () => {
      if (!createdTestDp) return;
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults"),
        { headers: authHeaders() },
      );
      const body = await json(resp);
      expect(body._test_lot_number).toBeDefined();
      expect(body._test_lot_number.label).toBe("Test Lot Number");
    });

    it("DELETE removes custom data point", async () => {
      if (!createdTestDp) return;
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults/_test_lot_number"),
        { method: "DELETE", headers: authHeaders() },
      );
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });

    it("DELETE blocks deleting built-in data point", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults/full_name"),
        { method: "DELETE", headers: authHeaders() },
      );
      expect(resp.status).toBe(400);
      const body = await json(resp);
      expect(body.error).toContain("built-in");
    });

    it("DELETE returns 404 for nonexistent data point", async () => {
      const resp = await fetch(
        url("/dashboard/api/data-point-defaults/nonexistent_xyz"),
        { method: "DELETE", headers: authHeaders() },
      );
      expect(resp.status).toBe(404);
    });
  });

  // ── 21. Form Data Points Endpoint ──────────────────────────────────

  describe("Form data points", () => {
    it("GET /form/data-points returns data points with categories (requires auth)", async () => {
      const resp = await fetch(url("/form/data-points"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body).toBe("object");
      expect(body.full_name).toBeDefined();
      expect(body.full_name.label).toBe("Full Name");
      expect(body.full_name.category).toBeDefined();
      expect(body.truck_number.category).toBe("trucking");
    });

    it("GET /form/data-points rejects without auth", async () => {
      const resp = await fetch(url("/form/data-points"));
      expect(resp.status).toBe(401);
    });
  });
});
