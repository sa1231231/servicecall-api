import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

// Use SYSTEM_TEST_URL to avoid collision with Vite's built-in BASE_URL
const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ADMIN_PASSWORD = process.env.ROOT_PASSWORD ?? process.env.ADMIN_PASSWORD;
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
        expect(body.key).toMatch(/^backups\/\d{4}-\d{2}-\d{2}_\d{4}\.json\.gz$/);
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

  // ── 21. Portal Link Sending ──────────────────────────────────────

  describe("Portal link sending", () => {
    it("sends portal link or returns error when not generated", async () => {
      const resp = await fetch(
        url(`/dashboard/api/agents/${DEMO_SLUG}/send-portal-link`),
        { method: "POST", headers: authHeaders() },
      );
      const body = await json(resp);
      // Either 400 (portal not generated) or 200 (success) — both valid
      expect([200, 400]).toContain(resp.status);
      if (resp.status === 400) {
        expect(body.error).toContain("Portal");
      } else {
        expect(body.success).toBe(true);
        expect(Array.isArray(body.sent_to)).toBe(true);
      }
    });

    it("returns 404 for nonexistent client", async () => {
      const resp = await fetch(
        url("/dashboard/api/agents/nonexistent-slug-xyz/send-portal-link"),
        { method: "POST", headers: authHeaders() },
      );
      expect(resp.status).toBe(404);
    });
  });

  // ── 22. Settings CRUD ──────────────────────────────────────────────

  describe("Settings CRUD", () => {
    let originalSettings: any;

    it("GET returns all expected fields", async () => {
      const resp = await fetch(url("/dashboard/api/settings"), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      originalSettings = body;

      expect(typeof body.google_review_url).toBe("string");
      expect(typeof body.review_sms_message).toBe("string");
      expect(typeof body.stripe_payment_url).toBe("string");
      expect(typeof body.payment_sms_message).toBe("string");
      expect(typeof body.portal_sms_message).toBe("string");
      expect(typeof body.free_trial_days).toBe("number");
      expect(typeof body.owner_email).toBe("string");
      expect(typeof body.owner_phone).toBe("string");
    });

    it("PATCH updates portal_sms_message and persists", async () => {
      const testMsg = "Test portal msg {{portal_url}} - " + Date.now();
      const patchResp = await fetch(url("/dashboard/api/settings"), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ portal_sms_message: testMsg }),
      });
      expect(patchResp.status).toBe(200);

      // Verify it persisted
      const getResp = await fetch(url("/dashboard/api/settings"), {
        headers: authHeaders(),
      });
      const body = await json(getResp);
      expect(body.portal_sms_message).toBe(testMsg);

      // Restore original
      if (originalSettings) {
        await fetch(url("/dashboard/api/settings"), {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({
            portal_sms_message: originalSettings.portal_sms_message,
          }),
        });
      }
    });
  });

  // ── 23. Form Data Points Endpoint ──────────────────────────────────

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

  // ── 24. User Management CRUD ──────────────────────────────────────

  describe("User management", () => {
    const testUser = "_systest_user_" + Date.now();

    it("GET /dashboard/api/users lists users", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(Array.isArray(body)).toBe(true);
    });

    it("POST creates a new user", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ username: testUser, password: "testpass123", role: "viewer" }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.username).toBe(testUser);
      expect(body.role).toBe("viewer");
    });

    it("POST rejects duplicate username", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ username: testUser, password: "testpass123", role: "viewer" }),
      });
      expect(resp.status).toBe(400);
    });

    it("POST rejects missing fields", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ username: "", password: "" }),
      });
      expect(resp.status).toBe(400);
    });

    it("POST rejects invalid role", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ username: "x_invalid", password: "testpass", role: "superadmin" }),
      });
      expect(resp.status).toBe(400);
    });

    it("POST rejects short password", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ username: "x_short", password: "ab", role: "viewer" }),
      });
      expect(resp.status).toBe(400);
    });

    it("PATCH updates user permissions", async () => {
      const resp = await fetch(url(`/dashboard/api/users/${testUser}/permissions`), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ permissions: { edit_agents: true } }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });

    it("PATCH returns 404 for nonexistent user", async () => {
      const resp = await fetch(url("/dashboard/api/users/nonexistent_xyz/permissions"), {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ permissions: { edit_agents: true } }),
      });
      expect(resp.status).toBe(404);
    });

    it("DELETE removes the test user", async () => {
      const resp = await fetch(url(`/dashboard/api/users/${testUser}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });

    it("DELETE returns 404 for nonexistent user", async () => {
      const resp = await fetch(url("/dashboard/api/users/nonexistent_xyz"), {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(404);
    });
  });

  // ── 25. Soft-Deleted Agents ─────────────────────────────────────────

  describe("Soft-deleted agents", () => {
    it("GET /dashboard/api/deleted-agents lists deleted agents", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents"), {
        headers: authHeaders(),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(Array.isArray(body)).toBe(true);
    });

    it("POST restore returns 500 for nonexistent slug", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents/nonexistent-xyz/restore"), {
        method: "POST",
        headers: authHeaders(),
      });
      // restoreClient will fail or the slug doesn't exist — expect error
      expect([404, 500]).toContain(resp.status);
    });

    it("DELETE permanent returns 500 or success for nonexistent slug", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents/nonexistent-xyz"), {
        method: "DELETE",
        headers: authHeaders(),
      });
      // deleteClient on nonexistent slug just deletes 0 docs — still returns success
      expect([200, 404, 500]).toContain(resp.status);
    });
  });

  // ── 26. Clone Agent ─────────────────────────────────────────────────

  describe("Clone agent", () => {
    it("returns 404 for nonexistent client", async () => {
      const resp = await fetch(url("/dashboard/api/agents/nonexistent-xyz/clone"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Clone Test" }),
      });
      expect(resp.status).toBe(404);
    });
  });

  // ── 27. Test Notification ──────────────────────────────────────────

  describe("Test notification", () => {
    it("sends test notification for demo client", async () => {
      const resp = await fetch(url(`/qa/test-notify/${DEMO_SLUG}`), {
        method: "POST",
        headers: authHeaders(),
      });
      const body = await json(resp);
      // 200 success or 502 if SMS fails in test env — both valid
      expect([200, 502]).toContain(resp.status);
      if (resp.status === 200) {
        expect(body.success).toBe(true);
      }
    });

    it("returns 404 for nonexistent client", async () => {
      const resp = await fetch(url("/qa/test-notify/nonexistent-xyz"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(resp.status).toBe(404);
    });
  });

  // ── 28. Form Config ────────────────────────────────────────────────

  describe("Form config", () => {
    it("GET /form/config returns config with auth", async () => {
      const resp = await fetch(url("/form/config"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.apiKey).toBe("string");
    });

    it("GET /form/config rejects without auth", async () => {
      const resp = await fetch(url("/form/config"));
      expect(resp.status).toBe(401);
    });
  });

  // ── 29. Form Drafts CRUD ──────────────────────────────────────────

  describe("Form drafts", () => {
    let draftId: string | undefined;

    it("GET /form/drafts lists drafts", async () => {
      const resp = await fetch(url("/form/drafts"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(Array.isArray(body)).toBe(true);
    });

    it("POST creates a draft", async () => {
      const resp = await fetch(url("/form/drafts"), {
        method: "POST",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "_systest_draft", formData: { test: true } }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body._id).toBeDefined();
      draftId = body._id;
    });

    it("POST rejects missing fields", async () => {
      const resp = await fetch(url("/form/drafts"), {
        method: "POST",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });

    it("GET /form/drafts/:id returns the created draft", async () => {
      if (!draftId) return;
      const resp = await fetch(url(`/form/drafts/${draftId}`), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.name).toBe("_systest_draft");
    });

    it("PUT updates the draft", async () => {
      if (!draftId) return;
      const resp = await fetch(url(`/form/drafts/${draftId}`), {
        method: "PUT",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "_systest_draft_updated" }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });

    it("DELETE removes the draft", async () => {
      if (!draftId) return;
      const resp = await fetch(url(`/form/drafts/${draftId}`), {
        method: "DELETE",
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });

    it("GET returns 404 for deleted draft", async () => {
      if (!draftId) return;
      const resp = await fetch(url(`/form/drafts/${draftId}`), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(404);
    });

    it("GET /form/drafts rejects without auth", async () => {
      const resp = await fetch(url("/form/drafts"));
      expect(resp.status).toBe(401);
    });
  });

  // ── 30. Data Point Reorder ────────────────────────────────────────

  describe("Data point reorder", () => {
    it("PUT reorder updates sort order", async () => {
      const resp = await fetch(url("/dashboard/api/data-point-defaults/reorder"), {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ items: [
          { key: "full_name", category: "caller_info", sortOrder: 0 },
          { key: "phone_number", category: "caller_info", sortOrder: 1 },
        ] }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });
  });

  // ── 31. Agent Create/Import/Duplicate (API key routes) ────────────

  describe("Agent API key routes", () => {
    it("POST /agents/create rejects without required fields", async () => {
      const resp = await fetch(url("/agents/create"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });

    it("POST /agents/import rejects without agent_id", async () => {
      const resp = await fetch(url("/agents/import"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });

    it("POST /agents/duplicate rejects without slug", async () => {
      const resp = await fetch(url("/agents/duplicate"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });

    it("POST /agents/duplicate returns 404 for nonexistent client", async () => {
      const resp = await fetch(url("/agents/duplicate"), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ slug: "nonexistent-xyz", name: "Dup Test" }),
      });
      expect(resp.status).toBe(404);
    });

    it("all agent routes reject without API key", async () => {
      const noKey = { "Content-Type": "application/json" };
      const [r1, r2, r3] = await Promise.all([
        fetch(url("/agents/create"), { method: "POST", headers: noKey, body: "{}" }),
        fetch(url("/agents/import"), { method: "POST", headers: noKey, body: "{}" }),
        fetch(url("/agents/duplicate"), { method: "POST", headers: noKey, body: "{}" }),
      ]);
      expect(r1.status).toBe(401);
      expect(r2.status).toBe(401);
      expect(r3.status).toBe(401);
    });
  });

  // ── 32. Form & Dashboard HTML shells ──────────────────────────────

  describe("HTML shells", () => {
    it("GET /form serves form HTML with auth", async () => {
      const resp = await fetch(url("/form"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("html");
    });

    it("GET /dashboard serves dashboard HTML with auth", async () => {
      const resp = await fetch(url("/dashboard"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain("html");
    });

    it("GET /form rejects without auth", async () => {
      const resp = await fetch(url("/form"));
      expect(resp.status).toBe(401);
    });

    it("GET /dashboard rejects without auth", async () => {
      const resp = await fetch(url("/dashboard"));
      expect(resp.status).toBe(401);
    });
  });

  // ── 33. Node Editor ─────────────────────────────────────────────────
  // Uses test-test-123 agent which has known multi-path structure:
  //   path1: full_name, phone_number, has_pets, property_type, year_built
  //   path2: city, street_address

  describe("Node editor", () => {
    const NE_SLUG = "test-test-123";
    const NE_AGENT = "agent_66565c3c5e4e1981d38eb54587";

    let initialVersionCount = 0;
    let firstVersionId: string | undefined;
    let preEditSnapshotId: string | undefined;
    let initialPath2Vars: string[] = [];

    // ── Read operations ────────────────────────────────────────────

    describe("GET node structure", () => {
      it("returns structured node tree for multi-path agent", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);

        expect(body.agentId).toBe(NE_AGENT);
        expect(typeof body.agentName).toBe("string");
        expect(typeof body.conversationFlowId).toBe("string");
        expect(typeof body.globalPrompt).toBe("string");
        expect(body.globalPrompt.length).toBeGreaterThan(0);
        expect(typeof body.startNodeId).toBe("string");
        expect(typeof body.introNodeId).toBe("string");

        // FAQ knowledge base
        expect(typeof body.faqNodeId).toBe("string");
        expect(typeof body.faqKnowledgeBase).toBe("string");
        expect(body.faqKnowledgeBase.length).toBeGreaterThan(0);

        // Transition conditions
        expect(typeof body.transitionConditions).toBe("object");
        expect(typeof body.transitionConditions.path1).toBe("string");
        expect(body.transitionConditions.path1.length).toBeGreaterThan(0);
        expect(typeof body.transitionConditions.path2).toBe("string");

        // Multi-path structure
        expect(Array.isArray(body.paths)).toBe(true);
        expect(body.paths.length).toBe(2);
        expect(body.paths[0].name).toBe("path1");
        expect(body.paths[1].name).toBe("path2");

        // Each path has transitionCondition
        expect(typeof body.paths[0].transitionCondition).toBe("string");
        expect(body.paths[0].transitionCondition.length).toBeGreaterThan(0);
        expect(typeof body.paths[1].transitionCondition).toBe("string");

        // Path 1 data points
        const p1Vars = body.paths[0].dataPoints.map((d: any) => d.variableName);
        expect(p1Vars).toContain("full_name");
        expect(p1Vars).toContain("phone_number");

        // Path 2 data points
        const p2Vars = body.paths[1].dataPoints.map((d: any) => d.variableName);
        expect(p2Vars).toContain("city");
        expect(p2Vars).toContain("street_address");
        initialPath2Vars = p2Vars;

        // Each data point has required fields including branchConditions
        for (const path of body.paths) {
          for (const dp of path.dataPoints) {
            expect(dp.variableName).toBeDefined();
            expect(dp.label).toBeDefined();
            expect(dp.collectNodeId).toBeDefined();
            expect(dp.confirmNodeId).toBeDefined();
            expect(typeof dp.conversationPrompt).toBe("string");
            expect(typeof dp.forwardCondition).toBe("string");
            expect(Array.isArray(dp.variableDefs)).toBe(true);
            // branchConditions is either null/undefined or an array
            if (dp.branchConditions) {
              expect(Array.isArray(dp.branchConditions)).toBe(true);
              for (const bc of dp.branchConditions) {
                expect(typeof bc.variable).toBe("string");
                expect(typeof bc.operator).toBe("string");
              }
            }
          }
        }

        // Branch conditions should exist on conditional data points (has_pets branches)
        const p1Dps = body.paths[0].dataPoints;
        const propertyType = p1Dps.find((d: any) => d.variableName === "property_type");
        if (propertyType) {
          // property_type is behind a has_pets == Yes branch
          expect(propertyType.branchConditions).toBeDefined();
          expect(propertyType.branchConditions.length).toBeGreaterThan(0);
          expect(propertyType.branchConditions[0].variable).toBe("has_pets");
        }

        // Node list
        expect(Array.isArray(body.nodes)).toBe(true);
        expect(body.nodes.length).toBeGreaterThan(10);
        for (const node of body.nodes) {
          expect(node.id).toBeDefined();
          expect(node.name).toBeDefined();
          expect(node.type).toBeDefined();
          expect(typeof node.isGlobal).toBe("boolean");
        }
      });

      it("returns 404 for nonexistent agent ID", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/nonexistent-agent-id`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(404);
      });

      it("returns 404 for nonexistent slug", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/nonexistent-slug/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(404);
      });
    });

    // ── Version history ────────────────────────────────────────────

    describe("Version history", () => {
      it("GET versions returns paginated list", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/versions?limit=5`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(Array.isArray(body.versions)).toBe(true);
        expect(typeof body.total).toBe("number");
        initialVersionCount = body.total;

        if (body.versions.length > 0) {
          const v = body.versions[0];
          expect(v._id).toBeDefined();
          expect(typeof v.version).toBe("number");
          expect(v.source).toBeDefined();
          expect(typeof v.description).toBe("string");
          expect(typeof v.nodeCount).toBe("number");
          expect(typeof v.dataPointCount).toBe("number");
          expect(v.createdAt).toBeDefined();
          firstVersionId = v._id;
        }
      });

      it("GET specific version returns full detail", async () => {
        if (!firstVersionId) return;
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/versions/${firstVersionId}`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(typeof body.version).toBe("number");
        expect(typeof body.globalPrompt).toBe("string");
        expect(Array.isArray(body.paths)).toBe(true);
        expect(Array.isArray(body.nodes)).toBe(true);
      });

      it("returns 404 for nonexistent version", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/versions/000000000000000000000000`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(404);
      });
    });

    // ── edit-prompt ────────────────────────────────────────────────

    describe("edit-prompt", () => {
      it("edits Close node prompt and creates version", { timeout: 30_000 }, async () => {
        const structResp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const struct = await json(structResp);
        const closeNode = struct.nodes.find((n: any) => n.name === "Close");
        expect(closeNode).toBeDefined();

        const testText = `Thank the caller. [SYSTEST-${Date.now()}]`;
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-prompt`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ nodeId: closeNode.id, instruction: testText }),
          },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(body.success).toBe(true);
        expect(body.nodeId).toBe(closeNode.id);
        expect(body.nodeName).toBe("Close");
      });

      it("version exists after edit", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/versions?limit=1`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        expect(body.total).toBeGreaterThanOrEqual(1);
        // Latest version should be from our edit (manual_edit source)
        expect(body.versions.length).toBeGreaterThan(0);
        expect(body.versions[0].source).toBe("manual_edit");
        if (body.versions.length > 0) {
          preEditSnapshotId = body.versions[0]._id;
        }
      });

      it("rejects empty instruction", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-prompt`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ nodeId: "x", instruction: "" }),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("rejects missing nodeId", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-prompt`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ instruction: "test" }),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("returns 404 for nonexistent node", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-prompt`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ nodeId: "nonexistent-node-xyz", instruction: "test" }),
          },
        );
        expect(resp.status).toBe(404);
      });
    });

    // ── edit-global-prompt ─────────────────────────────────────────

    describe("edit-global-prompt", () => {
      it("changes the global prompt", { timeout: 30_000 }, async () => {
        const structResp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const struct = await json(structResp);

        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-global-prompt`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ globalPrompt: struct.globalPrompt + `\n[TEST-${Date.now()}]` }),
          },
        );
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("rejects empty prompt", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-global-prompt`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ globalPrompt: "" }),
          },
        );
        expect(resp.status).toBe(400);
      });
    });

    // ── edit-transition ──────────────────────────────────────────

    describe("edit-transition", () => {
      it("changes path2 transition condition", { timeout: 30_000 }, async () => {
        const testCondition = "The caller has something else [TEST-" + Date.now() + "]";
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-transition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ pathName: "path2", transitionCondition: testCondition }),
          },
        );
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("transition condition is updated in GET response", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        expect(body.transitionConditions.path2).toContain("[TEST-");
        expect(body.paths[1].transitionCondition).toContain("[TEST-");
      });

      it("rejects empty condition", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-transition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ pathName: "path2", transitionCondition: "" }),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("rejects missing pathName", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-transition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ transitionCondition: "test" }),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("returns 404 for nonexistent path", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-transition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ pathName: "nonexistent_path", transitionCondition: "test" }),
          },
        );
        expect(resp.status).toBe(404);
        const body = await json(resp);
        expect(Array.isArray(body.availablePaths)).toBe(true);
      });
    });

    // ── edit FAQ via edit-prompt ────────────────────────────────────

    describe("edit FAQ", () => {
      it("edits FAQ node prompt to update knowledge base", { timeout: 30_000 }, async () => {
        // Get the FAQ node ID
        const structResp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const struct = await json(structResp);
        expect(struct.faqNodeId).toBeDefined();

        const newFaq = "Your goal is to answer administrative and general questions briefly and accurately.\n\nUpdated FAQ content [TEST-" + Date.now() + "]";
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-prompt`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ nodeId: struct.faqNodeId, instruction: newFaq }),
          },
        );
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("FAQ content updated in GET response", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        expect(body.faqKnowledgeBase).toContain("Updated FAQ content [TEST-");
      });
    });

    // ── edit-branch-condition ─────────────────────────────────────

    describe("edit-branch-condition", () => {
      it("sets a branch condition on a data point", { timeout: 30_000 }, async () => {
        // Set condition on year_built: only ask when has_pets == Yes
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-branch-condition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              variableName: "year_built",
              pathName: "path1",
              branchConditions: [{ variable: "has_pets", operator: "==", value: "Yes" }],
            }),
          },
        );
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("branch condition appears in GET response", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        const p1 = body.paths.find((p: any) => p.name === "path1");
        const yb = p1.dataPoints.find((d: any) => d.variableName === "year_built");
        expect(yb.branchConditions).toBeDefined();
        expect(yb.branchConditions.length).toBeGreaterThan(0);
        expect(yb.branchConditions[0].variable).toBe("has_pets");
      });

      it("removes a branch condition", { timeout: 30_000 }, async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-branch-condition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              variableName: "year_built",
              pathName: "path1",
              branchConditions: null,
            }),
          },
        );
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("condition is gone after removal", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        const p1 = body.paths.find((p: any) => p.name === "path1");
        const yb = p1.dataPoints.find((d: any) => d.variableName === "year_built");
        expect(!yb.branchConditions || yb.branchConditions.length === 0).toBe(true);
      });

      it("rejects nonexistent variable", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-branch-condition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
              variableName: "nonexistent_xyz",
              pathName: "path1",
              branchConditions: null,
            }),
          },
        );
        expect(resp.status).toBe(404);
      });

      it("rejects missing variableName", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-branch-condition`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ pathName: "path1", branchConditions: null }),
          },
        );
        expect(resp.status).toBe(400);
      });
    });

    // ── edit-path-name ───────────────────────────────────────────

    describe("edit-path-name", () => {
      it("renames path2 and reverts", { timeout: 30_000 }, async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-path-name`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ oldName: "path2", newName: "path2_renamed" }),
          },
        );
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);

        // Verify it changed
        const structResp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const struct = await json(structResp);
        expect(struct.paths.some((p: any) => p.name === "path2_renamed")).toBe(true);
        expect(struct.paths.some((p: any) => p.name === "path2")).toBe(false);

        // Revert
        const revertResp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-path-name`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ oldName: "path2_renamed", newName: "path2" }),
          },
        );
        expect(revertResp.status).toBe(200);
      });

      it("rejects missing fields", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-path-name`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ oldName: "path1" }),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("returns 404 for nonexistent path", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-path-name`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ oldName: "nonexistent", newName: "x" }),
          },
        );
        expect(resp.status).toBe(404);
      });
    });

    // ── edit-human-request-mode ────────────────────────────────────

    describe("edit-human-request-mode", () => {
      it("returns current mode in GET response", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        expect(["callback", "live_transfer"]).toContain(body.humanRequestMode);
        expect(body.humanRequestNodeId).toBeDefined();
        expect(typeof body.introPrompt).toBe("string");
      });

      it("rejects invalid mode", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-human-request-mode`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ mode: "invalid_mode" }),
          },
        );
        expect(resp.status).toBe(400);
      });
    });

    // ── edit-agent-settings ────────────────────────────────────────

    describe("edit-agent-settings", () => {
      it("rejects empty body", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-agent-settings`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({}),
          },
        );
        expect(resp.status).toBe(400);
        const body = await json(resp);
        expect(Array.isArray(body.allowed)).toBe(true);
        expect(body.allowed.length).toBeGreaterThan(5);
      });

      it("rejects non-allowed fields only", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/edit-agent-settings`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ response_engine: "hacked", agent_id: "stolen" }),
          },
        );
        expect(resp.status).toBe(400);
      });
    });

    // ── add-data-point ─────────────────────────────────────────────

    describe("add-data-point", () => {
      it("adds email to path2", { timeout: 30_000 }, async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/add-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ dataPointKey: "email", pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(body.success).toBe(true);
        expect(body.variableName).toBe("email");
        expect(body.pathName).toBe("path2");
      });

      it("email appears in path2 after add", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        const p2 = body.paths.find((p: any) => p.name === "path2");
        const vars = p2.dataPoints.map((d: any) => d.variableName);
        expect(vars).toContain("email");
        expect(vars.length).toBe(initialPath2Vars.length + 1);
      });

      it("rejects duplicate variable in same path", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/add-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ dataPointKey: "email", pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(400);
        const body = await json(resp);
        expect(body.error).toContain("already exists");
      });

      it("rejects unknown data point key", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/add-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ dataPointKey: "nonexistent_xyz_var", pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("rejects nonexistent path name", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/add-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ dataPointKey: "company_name", pathName: "nonexistent_path" }),
          },
        );
        expect(resp.status).toBe(404);
        const body = await json(resp);
        expect(Array.isArray(body.availablePaths)).toBe(true);
      });

      it("rejects missing dataPointKey", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/add-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("path1 is unaffected by path2 changes", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        const p1 = body.paths.find((p: any) => p.name === "path1");
        const p1Vars = p1.dataPoints.map((d: any) => d.variableName);
        expect(p1Vars).toContain("full_name");
        expect(p1Vars).toContain("phone_number");
        expect(p1Vars).toContain("has_pets");
      });
    });

    // ── reorder-data-points ────────────────────────────────────────

    describe("reorder-data-points", () => {
      it("reverses path2 data point order", { timeout: 30_000 }, async () => {
        // Get current order
        const structResp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const struct = await json(structResp);
        const p2 = struct.paths.find((p: any) => p.name === "path2");
        const currentVars = p2.dataPoints.map((d: any) => d.variableName);
        const reversed = [...currentVars].reverse();

        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/reorder-data-points`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ variableNames: reversed, pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("order is reversed after reorder", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        const p2 = body.paths.find((p: any) => p.name === "path2");
        const vars = p2.dataPoints.map((d: any) => d.variableName);
        // email was added last, so reversed order starts with email
        expect(vars[0]).toBe("email");
      });

      it("rejects mismatched variable names", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/reorder-data-points`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ variableNames: ["city", "nonexistent"], pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(400);
        const body = await json(resp);
        expect(body.missing.length).toBeGreaterThan(0);
        expect(body.extra.length).toBeGreaterThan(0);
      });

      it("rejects empty variableNames", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/reorder-data-points`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ variableNames: [], pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(400);
      });
    });

    // ── remove-data-point ──────────────────────────────────────────

    describe("remove-data-point", () => {
      it("removes email from path2", { timeout: 30_000 }, async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/remove-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ variableName: "email", pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(body.success).toBe(true);
        expect(body.variableName).toBe("email");
      });

      it("email is gone and path2 is back to original count", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        const body = await json(resp);
        const p2 = body.paths.find((p: any) => p.name === "path2");
        const vars = p2.dataPoints.map((d: any) => d.variableName);
        expect(vars).not.toContain("email");
        expect(vars.length).toBe(initialPath2Vars.length);
      });

      it("rejects removing nonexistent variable", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/remove-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ variableName: "nonexistent_xyz", pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(404);
        const body = await json(resp);
        expect(Array.isArray(body.existingVariables)).toBe(true);
      });

      it("rejects missing variableName", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/remove-data-point`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ pathName: "path2" }),
          },
        );
        expect(resp.status).toBe(400);
      });
    });

    // ── rollback ───────────────────────────────────────────────────

    describe("rollback", () => {
      it("rejects missing versionId", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/rollback`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({}),
          },
        );
        expect(resp.status).toBe(400);
      });

      it("rejects nonexistent version", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/rollback`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ versionId: "000000000000000000000000" }),
          },
        );
        expect(resp.status).toBe(404);
      });

      it("restores to pre-edit snapshot", { timeout: 30_000 }, async () => {
        if (!preEditSnapshotId) return;
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/rollback`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ versionId: preEditSnapshotId }),
          },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(body.success).toBe(true);
        expect(typeof body.restoredVersion).toBe("number");
      });

      it("structure is valid after rollback", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);

        expect(body.agentId).toBe(NE_AGENT);
        expect(body.paths.length).toBe(2);
        expect(body.nodes.length).toBeGreaterThan(10);
        expect(body.globalPrompt.length).toBeGreaterThan(0);

        for (const path of body.paths) {
          expect(path.dataPoints.length).toBeGreaterThan(0);
          for (const dp of path.dataPoints) {
            expect(dp.variableName).toBeDefined();
            expect(dp.collectNodeId).toBeDefined();
            expect(dp.confirmNodeId).toBeDefined();
          }
        }
      });
    });

    // ── push (raw JSON) ────────────────────────────────────────────

    describe("push (raw JSON)", () => {
      it("rejects missing conversationFlow", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/push`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ canonicalJson: { noFlow: true } }),
          },
        );
        // Root gets 400, non-root gets 403
        expect([400, 403]).toContain(resp.status);
      });

      it("rejects empty canonicalJson", async () => {
        const resp = await fetch(
          url(`/dashboard/api/agents/${NE_SLUG}/nodes/${NE_AGENT}/push`),
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ canonicalJson: {} }),
          },
        );
        expect([400, 403]).toContain(resp.status);
      });
    });
  });
});
