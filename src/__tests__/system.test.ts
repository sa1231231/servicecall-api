import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

// Use SYSTEM_TEST_URL to avoid collision with Vite's built-in BASE_URL
const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const DEMO_SLUG = "demo-530e570";

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-api-key": API_KEY!, "Content-Type": "application/json", ...extra };
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

    it("GET /dashboard/config returns apiKey", async () => {
      const resp = await fetch(url("/dashboard/config"));
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.apiKey).toBe("string");
      expect(body.apiKey.length).toBeGreaterThan(0);
    });
  });

  // ── 2. Auth ─────────────────────────────────────────────────────────────

  describe("Auth", () => {
    it("rejects requests with no API key", async () => {
      const resp = await fetch(url("/dashboard/api/agents"));
      expect(resp.status).toBe(401);
    });

    it("rejects requests with wrong API key", async () => {
      const resp = await fetch(url("/dashboard/api/agents"), {
        headers: { "x-api-key": "wrong-key" },
      });
      expect(resp.status).toBe(401);
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

      // Notification config should have retell_agents with canonical JSON
      expect(body.notification_config).toBeDefined();
      expect(body.notification_config.retell_agents).toBeDefined();
      expect(body.notification_config.retell_agents[body.agent_id]).toBeDefined();
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

  // ── 8. Update Agent Fields ────────────────────────────────────────────

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
        body: JSON.stringify({ name: "hacked" }),
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
});
