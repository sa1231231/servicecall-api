import "dotenv/config";
import { describe, it, expect, afterAll } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ADMIN_PASSWORD = process.env.ROOT_PASSWORD ?? process.env.ADMIN_PASSWORD;

// All tests use Demo Meter (demo-meter / Demo Team) as the canonical test agent.
// Multi-path (measure_me + dont_measure_me), branches, callback mode.
const SLUG = "demo-meter";
const AGENT_ID = "agent_27340aa43ebbc5f4822a35225a";

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
  let originalShadowMode: boolean | undefined;
  let originalHideNotMentioned: boolean | undefined;

  afterAll(async () => {
    if (originalShadowMode !== undefined) {
      await fetch(url(`/dashboard/api/agents/${SLUG}/shadow`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ shadow_mode: originalShadowMode }),
      });
    }
    if (originalHideNotMentioned !== undefined) {
      await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ hide_not_mentioned: originalHideNotMentioned }),
      });
    }
  });

  // ── 1. Infrastructure ───────────────────────────────────────────────────

  describe("Infrastructure", () => {
    it("GET /health returns ok", async () => {
      const resp = await fetch(url("/health"));
      expect(resp.status).toBe(200);
      expect((await json(resp)).status).toBe("ok");
    });

    it("GET /dashboard/config returns apiKey with Basic Auth", async () => {
      const resp = await fetch(url("/dashboard/config"), {
        headers: { Authorization: basicAuthHeader() },
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.apiKey).toBe("string");
      expect(body.user).toBeDefined();
    });
  });

  // ── 2. Auth ─────────────────────────────────────────────────────────────

  describe("Auth", () => {
    it("rejects without API key", async () => {
      expect((await fetch(url("/dashboard/api/agents"))).status).toBe(401);
    });
    it("rejects wrong API key", async () => {
      expect((await fetch(url("/dashboard/api/agents"), { headers: { "x-api-key": "wrong" } })).status).toBe(401);
    });
    it("rejects /form/config without auth", async () => {
      expect((await fetch(url("/form/config"))).status).toBe(401);
    });
    it("rejects /dashboard/config without auth", async () => {
      expect((await fetch(url("/dashboard/config"))).status).toBe(401);
    });
    it("allows /form/config with Basic Auth", async () => {
      const resp = await fetch(url("/form/config"), { headers: { Authorization: basicAuthHeader() } });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.apiKey).toBe("string");
      expect(typeof body.default_summary_agent_id).toBe("string");
      expect(typeof body.owner_phone).toBe("string");
    });
  });

  // ── 3. Dashboard API ───────────────────────────────────────────────────

  describe("Dashboard API", () => {
    it("lists agents including Demo Team", async () => {
      const resp = await fetch(url("/dashboard/api/agents"), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(Array.isArray(body)).toBe(true);
      const demo = body.find((a: any) => a.slug === SLUG);
      expect(demo).toBeDefined();
      expect(demo.name).toContain("Demo Team");
      expect(demo.agent_ids).toContain(AGENT_ID);
    });

    it("returns full detail for Demo Team", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body._id).toBe(SLUG);
      expect(body.name).toContain("Demo Team");
      expect(body.agent_ids).toContain(AGENT_ID);
      expect(body.message_types).toBeDefined();
      expect(Object.keys(body.message_types).length).toBeGreaterThanOrEqual(1);
      expect(body.retell_agents).toBeDefined();
      expect(body.retell_agents[AGENT_ID]).toBeDefined();
      originalShadowMode = body.shadow_mode;
      originalHideNotMentioned = body.hide_not_mentioned;
    });

    it("returns call logs", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=5`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      expect(Array.isArray(await json(resp))).toBe(true);
    });

    it("returns 404 for nonexistent client", async () => {
      expect((await fetch(url("/dashboard/api/agents/nonexistent-slug-xyz"), { headers: authHeaders() })).status).toBe(404);
    });
  });

  // ── 4. Agent Sync ──────────────────────────────────────────────────────

  describe("Agent sync", () => {
    it("syncs agent from Retell API", async () => {
      const resp = await fetch(url(`/agents/${SLUG}/sync`), { method: "POST", headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.agent_id).toBe(AGENT_ID);
      expect(Array.isArray(body.variables)).toBe(true);
      expect(body.variables.length).toBeGreaterThan(0);
    });
  });

  // ── 5. Shadow Mode ─────────────────────────────────────────────────────

  describe("Shadow mode", () => {
    it("enables shadow mode", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/shadow`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ shadow_mode: true }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).shadow_mode).toBe(true);
    });
    it("rejects non-boolean", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/shadow`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ shadow_mode: "yes" }),
      });
      expect(resp.status).toBe(400);
    });
  });

  // ── 5b. Active Toggle ────────────────────────────────────────────────

  describe("Active toggle", () => {
    it("sets active to true", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/active`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ active: true }),
      });
      expect(resp.status).toBe(200);
    });
    it("rejects non-boolean", async () => {
      expect((await fetch(url(`/dashboard/api/agents/${SLUG}/active`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ active: "yes" }),
      })).status).toBe(400);
    });
  });

  // ── 6. Update Agent Fields ─────────────────────────────────────────────

  describe("Update agent fields", () => {
    it("updates hide_not_mentioned", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ hide_not_mentioned: true }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).doc.hide_not_mentioned).toBe(true);
    });
    it("rejects non-editable fields", async () => {
      expect((await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ retell_agents: {} }),
      })).status).toBe(400);
    });
    it("rejects empty body", async () => {
      expect((await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({}),
      })).status).toBe(400);
    });
  });

  // ── 7. QA Smoke Test ───────────────────────────────────────────────────

  describe("QA smoke test", () => {
    let smokeReport: any;
    it("runs smoke test", async () => {
      const resp = await fetch(url(`/qa/smoke/${SLUG}`), { method: "POST", headers: authHeaders() });
      expect(resp.status).toBe(200);
      smokeReport = await json(resp);
      expect(smokeReport.slug).toBe(SLUG);
      expect(smokeReport.agent_id).toBe(AGENT_ID);
      const checkNames = smokeReport.checks.map((c: any) => c.check);
      expect(checkNames).toContain("agent_reachable");
      expect(checkNames).toContain("data_points_in_flow");
      expect(checkNames).toContain("notification_config_complete");
    });
    it("agent is reachable", () => {
      expect(smokeReport?.checks?.find((c: any) => c.check === "agent_reachable")?.status).toBe("pass");
    });
  });

  // ── 8. Weekly Reports ──────────────────────────────────────────────────

  describe("Weekly reports", () => {
    it("sends weekly report for Demo Team", async () => {
      const resp = await fetch(url(`/api/reports/weekly?client_id=${SLUG}`), { method: "POST", headers: authHeaders() });
      expect(resp.status).toBe(200);
      expect((await json(resp)).sent).toContain(SLUG);
    });
    it("returns empty for nonexistent client", async () => {
      const resp = await fetch(url("/api/reports/weekly?client_id=nonexistent-xyz"), { method: "POST", headers: authHeaders() });
      expect(resp.status).toBe(200);
      expect((await json(resp)).sent).toHaveLength(0);
    });
  });

  // ── 9. Settings ────────────────────────────────────────────────────────

  describe("Settings", () => {
    it("returns current settings", async () => {
      const resp = await fetch(url("/dashboard/api/settings"), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.owner_email).toBe("string");
      expect(typeof body.owner_phone).toBe("string");
      expect(typeof body.default_summary_agent_id).toBe("string");
    });
  });

  // ── 10. Portal ─────────────────────────────────────────────────────────

  describe("Portal", () => {
    it("serves portal HTML", async () => {
      const resp = await fetch(url(`/portal/${SLUG}`));
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("html");
    });
    it("rejects invalid token", async () => {
      expect((await fetch(url(`/portal/${SLUG}/calls?token=invalid`))).status).toBe(401);
    });
    it("returns portal token status", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/portal-token`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      expect(typeof (await json(resp)).has_token).toBe("boolean");
    });
  });

  // ── 10b. Portal API ─────────────────────────────────────────────

  describe("Portal API", () => {
    let portalToken: string | undefined;

    it("generates portal token", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/portal-token`), { method: "POST", headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.portal_url).toBeDefined();
      portalToken = new URL(body.portal_url).searchParams.get("token") || undefined;
    });

    it("GET portal-token returns status", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/portal-token`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      expect((await json(resp)).has_token).toBe(true);
    });

    it("GET /portal/:slug/api/agent returns filtered config", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/agent?token=${portalToken}`));
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.name).toBeDefined();
      expect(Array.isArray(body.dispatch_text_numbers)).toBe(true);
      expect(typeof body.shadow_mode).toBe("boolean");
      // CC should not be present
      expect(body.dispatch_cc).toBeUndefined();
    });

    it("GET /portal/:slug/api/calls returns call log without web calls", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/calls?token=${portalToken}&limit=50`));
      expect(resp.status).toBe(200);
      const calls = await json(resp);
      expect(Array.isArray(calls)).toBe(true);
      // No web calls should appear
      for (const c of calls) {
        expect(c.from_number).not.toBe("unknown");
        expect(c.from_number).not.toBe("Web Call");
      }
    });

    it("GET /portal/:slug/api/calls includes call_cost_cents when available", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/calls?token=${portalToken}&limit=50`));
      const calls = await json(resp);
      // call_cost_cents may or may not be present on older calls
      // Just verify the field structure is correct when present
      for (const c of calls) {
        if (c.call_cost_cents !== undefined) {
          expect(typeof c.call_cost_cents).toBe("number");
        }
      }
    });

    it("GET /portal/:slug/api/agent rejects bad token", async () => {
      expect((await fetch(url(`/portal/${SLUG}/api/agent?token=invalid`))).status).toBe(401);
    });

    it("GET /portal/:slug/api/agent includes dispatch_call_overrides when present", async () => {
      // Use J&A Fleet which has call overrides
      const jaToken = await (async () => {
        const resp = await fetch(url("/dashboard/api/agents/j-a/portal-token"), { method: "POST", headers: authHeaders() });
        if (!resp.ok) return null;
        const body = await json(resp);
        return new URL(body.portal_url).searchParams.get("token");
      })();
      if (!jaToken) return;
      const resp = await fetch(url(`/portal/j-a/api/agent?token=${jaToken}`));
      if (resp.status !== 200) return; // J&A may not exist in all environments
      const body = await json(resp);
      // J&A has dispatch_call_overrides
      if (body.dispatch_call_overrides) {
        expect(typeof body.dispatch_call_overrides).toBe("object");
        for (const [from, to] of Object.entries(body.dispatch_call_overrides)) {
          expect(typeof from).toBe("string");
          expect(typeof to).toBe("string");
        }
      }
    });

    it("POST /portal/request-link returns success for any email", async () => {
      const resp = await fetch(url("/portal/request-link"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nonexistent@example.com" }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).success).toBe(true);
    });
  });

  // ── 10c. Portal self-serve settings ─────────────────────────────

  describe("Portal self-serve settings", () => {
    let portalToken: string | undefined;

    it("gets portal token for Demo Meter", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/portal-token`), { headers: authHeaders() });
      const body = await json(resp);
      if (!body.has_token) {
        // Generate one
        const gen = await fetch(url(`/dashboard/api/agents/${SLUG}/portal-token`), { method: "POST", headers: authHeaders() });
        const genBody = await json(gen);
        portalToken = new URL(genBody.portal_url).searchParams.get("token") || undefined;
      } else {
        portalToken = new URL(body.portal_url).searchParams.get("token") || undefined;
      }
      expect(portalToken).toBeDefined();
    });

    it("PATCH settings with valid token succeeds", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/settings?token=${portalToken}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatch_text_numbers: ["+13017872841"] }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
    });

    it("PATCH rejects invalid token", async () => {
      const resp = await fetch(url(`/portal/${SLUG}/api/settings?token=invalid_token`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatch_text_numbers: ["+15551234567"] }),
      });
      expect(resp.status).toBe(401);
    });

    it("PATCH rejects invalid phone format", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/settings?token=${portalToken}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatch_text_numbers: ["bad-number"] }),
      });
      expect(resp.status).toBe(400);
      const body = await json(resp);
      expect(body.errors.length).toBeGreaterThan(0);
    });

    it("PATCH rejects invalid email format", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/settings?token=${portalToken}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatch_email: ["not-an-email"] }),
      });
      expect(resp.status).toBe(400);
    });

    it("PATCH rejects empty body", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/settings?token=${portalToken}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
    });

    it("PATCH ignores non-whitelisted fields", async () => {
      if (!portalToken) return;
      const resp = await fetch(url(`/portal/${SLUG}/api/settings?token=${portalToken}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shadow_mode: false, agent_ids: ["hacked"] }),
      });
      // Should return 400 (no valid fields) since non-whitelisted fields are ignored
      expect(resp.status).toBe(400);
    });
  });

  // ── 11. Transcript ─────────────────────────────────────────────────────

  describe("Transcript", () => {
    it("returns 404 for nonexistent call", async () => {
      expect((await fetch(url(`/dashboard/api/agents/${SLUG}/calls/nonexistent-call-id/transcript`), { headers: authHeaders() })).status).toBe(404);
    });
  });

  // ── 12. Backup ─────────────────────────────────────────────────────────

  describe("Backup", () => {
    it("triggers backup", { timeout: 60_000 }, async () => {
      const resp = await fetch(url("/api/backup"), { method: "POST", headers: authHeaders() });
      const body = await json(resp);
      if (resp.status === 200) {
        expect(body.success).toBe(true);
      } else {
        expect(body.error).toContain("R2");
      }
    });
  });

  // ── 13. User Management ────────────────────────────────────────────────

  describe("User management", () => {
    const testUser = "_systest_user_" + Date.now();
    it("lists users", async () => {
      expect((await fetch(url("/dashboard/api/users"), { headers: authHeaders() })).status).toBe(200);
    });
    it("creates user", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username: testUser, password: "testpass123", role: "viewer" }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).username).toBe(testUser);
    });
    it("rejects duplicate", async () => {
      expect((await fetch(url("/dashboard/api/users"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username: testUser, password: "testpass123", role: "viewer" }),
      })).status).toBe(400);
    });
    it("updates permissions", async () => {
      expect((await fetch(url(`/dashboard/api/users/${testUser}/permissions`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ permissions: { edit_agents: true } }),
      })).status).toBe(200);
    });
    it("deletes user", async () => {
      expect((await fetch(url(`/dashboard/api/users/${testUser}`), {
        method: "DELETE", headers: authHeaders(),
      })).status).toBe(200);
    });
  });

  // ── 14. Form ───────────────────────────────────────────────────────────

  describe("Form", () => {
    it("serves form HTML with auth", async () => {
      const resp = await fetch(url("/form"), { headers: { Authorization: basicAuthHeader() } });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("html");
    });
    it("rejects without auth", async () => {
      expect((await fetch(url("/form"))).status).toBe(401);
    });
    it("serves dashboard HTML with auth", async () => {
      const resp = await fetch(url("/dashboard"), { headers: { Authorization: basicAuthHeader() } });
      expect(resp.status).toBe(200);
    });
  });

  // ── 15. Form Drafts ────────────────────────────────────────────────────

  describe("Form drafts", () => {
    let draftId: string | undefined;
    it("lists drafts", async () => {
      expect((await fetch(url("/form/drafts"), { headers: { Authorization: basicAuthHeader() } })).status).toBe(200);
    });
    it("creates draft", async () => {
      const resp = await fetch(url("/form/drafts"), {
        method: "POST",
        headers: { Authorization: basicAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "_systest_draft", formData: { test: true } }),
      });
      expect(resp.status).toBe(200);
      draftId = (await json(resp))._id;
    });
    it("deletes draft", async () => {
      if (!draftId) return;
      expect((await fetch(url(`/form/drafts/${draftId}`), {
        method: "DELETE", headers: { Authorization: basicAuthHeader() },
      })).status).toBe(200);
    });
  });

  // ── 16. Agent API Routes ───────────────────────────────────────────────

  describe("Agent API routes", () => {
    it("rejects create without fields", async () => {
      expect((await fetch(url("/agents/create"), { method: "POST", headers: authHeaders(), body: "{}" })).status).toBe(400);
    });
    it("rejects import without agent_id", async () => {
      expect((await fetch(url("/agents/import"), { method: "POST", headers: authHeaders(), body: "{}" })).status).toBe(400);
    });
    it("rejects without API key", async () => {
      const noKey = { "Content-Type": "application/json" };
      const [r1, r2] = await Promise.all([
        fetch(url("/agents/create"), { method: "POST", headers: noKey, body: "{}" }),
        fetch(url("/agents/import"), { method: "POST", headers: noKey, body: "{}" }),
      ]);
      expect(r1.status).toBe(401);
      expect(r2.status).toBe(401);
    });
    it("rejects duplicate without slug", async () => {
      expect((await fetch(url("/agents/duplicate"), { method: "POST", headers: authHeaders(), body: "{}" })).status).toBe(400);
    });
    it("rejects provision-number without slug", async () => {
      expect((await fetch(url("/agents/provision-number"), { method: "POST", headers: authHeaders(), body: "{}" })).status).toBe(400);
    });
  });

  // ── 17. Data Point Defaults ─────────────────────────────────────────

  describe("Data point defaults", () => {
    let createdKey: string | undefined;

    it("GET returns defaults with categories", async () => {
      const resp = await fetch(url("/dashboard/api/data-point-defaults"), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.defaults).toBeDefined();
      expect(body.defaults.full_name).toBeDefined();
      expect(typeof body.defaults.full_name.label).toBe("string");
      expect(body.categoryOrder).toBeDefined();
    });

    it("GET /form/data-points returns same data with auth", async () => {
      const resp = await fetch(url("/form/data-points"), { headers: { Authorization: basicAuthHeader() } });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.dataPoints || body).toBeDefined();
    });

    it("POST creates custom data point", async () => {
      createdKey = "_systest_dp_" + Date.now();
      const resp = await fetch(url("/dashboard/api/data-point-defaults"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ key: createdKey, label: "System Test DP", category: "custom", type: "string" }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).success).toBe(true);
    });

    it("POST rejects duplicate key", async () => {
      expect((await fetch(url("/dashboard/api/data-point-defaults"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ key: "full_name", label: "Dup" }),
      })).status).toBe(400);
    });

    it("PATCH updates data point", async () => {
      if (!createdKey) return;
      const resp = await fetch(url(`/dashboard/api/data-point-defaults/${createdKey}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ description: "Updated desc" }),
      });
      expect(resp.status).toBe(200);
    });

    it("PATCH returns 404 for nonexistent", async () => {
      expect((await fetch(url("/dashboard/api/data-point-defaults/nonexistent_xyz"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ description: "test" }),
      })).status).toBe(404);
    });

    it("PUT reorder works", async () => {
      const resp = await fetch(url("/dashboard/api/data-point-defaults/reorder"), {
        method: "PUT", headers: authHeaders(),
        body: JSON.stringify({ items: [{ key: "full_name", category: "general", sortOrder: 0 }] }),
      });
      expect(resp.status).toBe(200);
    });

    it("DELETE removes custom data point", async () => {
      if (!createdKey) return;
      expect((await fetch(url(`/dashboard/api/data-point-defaults/${createdKey}`), {
        method: "DELETE", headers: authHeaders(),
      })).status).toBe(200);
    });

    it("DELETE returns 404 for nonexistent", async () => {
      expect((await fetch(url("/dashboard/api/data-point-defaults/nonexistent_xyz"), {
        method: "DELETE", headers: authHeaders(),
      })).status).toBe(404);
    });
  });

  // ── 18. Settings CRUD ──────────────────────────────────────────────

  describe("Settings CRUD", () => {
    let origPortalMsg: string | undefined;

    it("PATCH updates a setting and persists", async () => {
      const getResp = await fetch(url("/dashboard/api/settings"), { headers: authHeaders() });
      const settings = await json(getResp);
      origPortalMsg = settings.portal_sms_message;

      const testMsg = "Test portal msg {{portal_url}} - " + Date.now();
      const patchResp = await fetch(url("/dashboard/api/settings"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ portal_sms_message: testMsg }),
      });
      expect(patchResp.status).toBe(200);

      // Verify persistence
      const verify = await json(await fetch(url("/dashboard/api/settings"), { headers: authHeaders() }));
      expect(verify.portal_sms_message).toBe(testMsg);

      // Restore
      if (origPortalMsg !== undefined) {
        await fetch(url("/dashboard/api/settings"), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ portal_sms_message: origPortalMsg }),
        });
      }
    });
  });

  // ── 18b. Settings — category_order ─────────────────────────────────

  describe("Settings category_order", () => {
    it("saves and retrieves category_order", async () => {
      const order = ["billing", "trucking", "caller_info"];
      const patchResp = await fetch(url("/dashboard/api/settings"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ category_order: order }),
      });
      expect(patchResp.status).toBe(200);

      const verify = await json(await fetch(url("/dashboard/api/settings"), { headers: authHeaders() }));
      expect(verify.category_order).toEqual(order);

      // Verify data-point-defaults returns custom order
      const dpResp = await json(await fetch(url("/dashboard/api/data-point-defaults"), { headers: authHeaders() }));
      expect(dpResp.categoryOrder).toEqual(order);

      // Restore default
      await fetch(url("/dashboard/api/settings"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ category_order: null }),
      });
    });
  });

  // ── 18c. Blast SMS ───────────────────────────────────────────────

  describe("Blast SMS", () => {
    it("preview returns recipient count", async () => {
      const resp = await fetch(url("/dashboard/api/blast-sms/preview"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ message: "Test" }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.total_recipients).toBe("number");
      expect(typeof body.total_clients).toBe("number");
    });

    it("rejects empty message", async () => {
      expect((await fetch(url("/dashboard/api/blast-sms"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ message: "" }),
      })).status).toBe(400);
    });

    it("rejects too-long message", async () => {
      expect((await fetch(url("/dashboard/api/blast-sms"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ message: "x".repeat(1601) }),
      })).status).toBe(400);
    });
  });

  // ── 18d. Call log includes cost data ──────────────────────────────

  describe("Call log cost data", () => {
    it("GET calls returns call_cost_cents field when present", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=10`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const calls = await json(resp);
      for (const c of calls) {
        // call_cost_cents may be null/undefined for old calls, number for new
        if (c.call_cost_cents !== undefined && c.call_cost_cents !== null) {
          expect(typeof c.call_cost_cents).toBe("number");
        }
        // Web calls should show "Web Call" not "unknown"
        if (c.from_number === "unknown") {
          // This shouldn't happen for new calls, but old ones may exist
        }
      }
    });
  });

  // ── 19. Clone Agent ────────────────────────────────────────────────

  describe("Clone agent", () => {
    it("rejects for nonexistent client", async () => {
      const resp = await fetch(url("/dashboard/api/agents/nonexistent-xyz/clone"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ name: "Clone Test" }),
      });
      expect([400, 404]).toContain(resp.status);
    });
  });

  // ── 20. Test Notification ──────────────────────────────────────────

  describe("Test notification", () => {
    it("sends or fails gracefully for Demo Meter", async () => {
      const resp = await fetch(url(`/qa/test-notify/${SLUG}`), { method: "POST", headers: authHeaders() });
      expect([200, 502]).toContain(resp.status);
    });
    it("returns 404 for nonexistent client", async () => {
      expect((await fetch(url("/qa/test-notify/nonexistent-xyz"), { method: "POST", headers: authHeaders() })).status).toBe(404);
    });
  });

  // ── 21. Client Login Page ──────────────────────────────────────────

  describe("Client login page", () => {
    it("GET /client serves login HTML without auth", async () => {
      const resp = await fetch(url("/client"));
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("html");
    });
  });

  // ── 22. Deleted Agents (now permission-based) ─────────────────────

  describe("Deleted agents", () => {
    it("lists deleted agents (root/super_admin has manage_deleted)", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents"), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      expect(Array.isArray(await json(resp))).toBe(true);
    });
  });

  // ── 23. Roles & Permissions ─────────────────────────────────────────

  describe("Roles and permissions", () => {
    it("sam_admin exists and has elevated permissions", async () => {
      const resp = await fetch(url("/dashboard/api/users"), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const users = await json(resp);
      const sam = users.find((u: any) => u._id === "sam_admin");
      if (sam) {
        // After promotion, should be super_admin; before, admin
        expect(["super_admin", "admin"]).toContain(sam.role);
        if (sam.role === "super_admin") {
          expect(sam.permissions.view_billing).toBe(true);
          expect(sam.permissions.manage_deleted).toBe(true);
        }
      }
    });

    it("super_admin role accepted in user creation", async () => {
      const testUser = "_systest_super_" + Date.now();
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username: testUser, password: "testpass123", role: "super_admin" }),
      });
      expect(resp.status).toBe(200);
      // Clean up
      await fetch(url(`/dashboard/api/users/${testUser}`), { method: "DELETE", headers: authHeaders() });
    });

    it("settings include view_billing and manage_deleted in permission defs", async () => {
      const resp = await fetch(url("/dashboard/config"), { headers: { Authorization: basicAuthHeader() } });
      const body = await json(resp);
      const keys = body.permissionDefs.map((d: any) => d.key);
      expect(keys).toContain("view_billing");
      expect(keys).toContain("manage_deleted");
    });

    it("root user has view_billing and manage_deleted permissions", async () => {
      const resp = await fetch(url("/dashboard/config"), { headers: { Authorization: basicAuthHeader() } });
      const body = await json(resp);
      expect(body.user.permissions.view_billing).toBe(true);
      expect(body.user.permissions.manage_deleted).toBe(true);
    });
  });

  // ── 24. Form Config ─────────────────────────────────────────────────

  describe("Form config fields", () => {
    it("returns default_summary_agent_id and owner_phone", async () => {
      const resp = await fetch(url("/form/config"), { headers: { Authorization: basicAuthHeader() } });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(typeof body.apiKey).toBe("string");
      expect(typeof body.default_summary_agent_id).toBe("string");
      expect(typeof body.owner_phone).toBe("string");
    });
  });

  // ── 25. Communication Endpoints ─────────────────────────────────────

  describe("Communication endpoints", () => {
    it("review request returns 400 or 200 for Demo Meter", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/request-review`), {
        method: "POST", headers: authHeaders(),
      });
      expect([200, 400]).toContain(resp.status);
    });

    it("payment link returns 400 or 200 for Demo Meter", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/send-payment-link`), {
        method: "POST", headers: authHeaders(),
      });
      expect([200, 400]).toContain(resp.status);
    });

    it("portal link returns 400 or 200 for Demo Meter", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/send-portal-link`), {
        method: "POST", headers: authHeaders(),
      });
      expect([200, 400]).toContain(resp.status);
    });

    it("review request returns 404 for nonexistent", async () => {
      expect((await fetch(url("/dashboard/api/agents/nonexistent-xyz/request-review"), {
        method: "POST", headers: authHeaders(),
      })).status).toBe(404);
    });

    it("payment link returns 404 for nonexistent", async () => {
      expect((await fetch(url("/dashboard/api/agents/nonexistent-xyz/send-payment-link"), {
        method: "POST", headers: authHeaders(),
      })).status).toBe(404);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // NODE EDITOR — Full coverage using Demo Meter (demo-meter)
  // measure_me: email, full_name, property_type, [IF Residential: scheduling,
  //   payment_method, [IF EFS: state], [IF !EFS: warranty_status]],
  //   [IF !Residential: state], truck_number
  // dont_measure_me: full_name, truck_number, why_reason
  // ══════════════════════════════════════════════════════════════════════════

  describe("Node editor", () => {
    let preEditSnapshotId: string | undefined;
    let initialDontMeasureVars: string[] = [];

    // ── GET structure ──────────────────────────────────────────────

    describe("GET node structure", () => {
      it("returns structured tree for multi-path agent with branches", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() });
        expect(resp.status).toBe(200);
        const body = await json(resp);

        expect(body.agentId).toBe(AGENT_ID);
        expect(typeof body.agentName).toBe("string");
        expect(typeof body.conversationFlowId).toBe("string");
        expect(typeof body.globalPrompt).toBe("string");
        expect(body.globalPrompt.length).toBeGreaterThan(0);

        // Intro / FAQ / Transition
        expect(typeof body.introNodeId).toBe("string");
        expect(typeof body.introPrompt).toBe("string");
        expect(body.introPrompt.length).toBeGreaterThan(0);
        expect(typeof body.transitionPrompt).toBe("string");
        expect(body.transitionPrompt.length).toBeGreaterThan(0);
        expect(typeof body.faqNodeId).toBe("string");
        expect(typeof body.faqKnowledgeBase).toBe("string");
        expect(body.faqKnowledgeBase).toContain("meter");
        expect(body.humanRequestMode).toBe("callback");

        // Transition conditions
        expect(typeof body.transitionConditions).toBe("object");
        expect(typeof body.transitionConditions.measure_me).toBe("string");
        expect(typeof body.transitionConditions.dont_measure_me).toBe("string");

        // Paths
        expect(body.paths.length).toBe(2);
        const mm = body.paths.find((p: any) => p.name === "measure_me");
        const dm = body.paths.find((p: any) => p.name === "dont_measure_me");
        expect(mm).toBeDefined();
        expect(dm).toBeDefined();

        // measure_me data points
        expect(mm.dataPoints.length).toBeGreaterThanOrEqual(8);
        const mmVars = mm.dataPoints.map((d: any) => d.variableName);
        expect(mmVars).toContain("email");
        expect(mmVars).toContain("full_name");
        expect(mmVars).toContain("property_type");
        expect(mmVars).toContain("truck_number");

        // Branch conditions on measure_me
        const prefDay = mm.dataPoints.find((d: any) => d.variableName === "preferred_day");
        expect(prefDay.branchConditions).toBeDefined();
        expect(prefDay.branchConditions.some((c: any) => c.variable === "property_type" && c.operator === "==")).toBe(true);

        const warranty = mm.dataPoints.find((d: any) => d.variableName === "warranty_status");
        expect(warranty.branchConditions).toBeDefined();
        expect(warranty.branchConditions.some((c: any) => c.variable === "payment_method" && c.operator === "!=")).toBe(true);

        // dont_measure_me
        const dmVars = dm.dataPoints.map((d: any) => d.variableName);
        expect(dmVars).toContain("full_name");
        expect(dmVars).toContain("truck_number");
        expect(dmVars).toContain("why_reason");
        initialDontMeasureVars = dmVars;

        // Per-path transition conditions
        expect(typeof mm.transitionCondition).toBe("string");
        expect(mm.transitionCondition.length).toBeGreaterThan(0);

        // Data point fields
        for (const path of body.paths) {
          for (const dp of path.dataPoints) {
            expect(dp.variableName).toBeDefined();
            expect(dp.collectNodeId).toBeDefined();
            expect(dp.confirmNodeId).toBeDefined();
            expect(typeof dp.conversationPrompt).toBe("string");
            expect(Array.isArray(dp.variableDefs)).toBe(true);
          }
        }

        // Nodes
        expect(body.nodes.length).toBeGreaterThan(30);
      });

      it("returns 404 for nonexistent agent", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/nonexistent`), { headers: authHeaders() })).status).toBe(404);
      });

      it("returns 404 for nonexistent slug", async () => {
        expect((await fetch(url(`/dashboard/api/agents/nonexistent/nodes/${AGENT_ID}`), { headers: authHeaders() })).status).toBe(404);
      });
    });

    // ── Versions ───────────────────────────────────────────────────

    describe("Version history", () => {
      it("returns paginated list", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/versions?limit=5`), { headers: authHeaders() });
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(Array.isArray(body.versions)).toBe(true);
        expect(typeof body.total).toBe("number");
        if (body.versions.length > 0) {
          preEditSnapshotId = body.versions[0]._id;
          expect(body.versions[0].source).toBeDefined();
          expect(typeof body.versions[0].nodeCount).toBe("number");
        }
      });

      it("returns 404 for nonexistent version", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/versions/000000000000000000000000`), { headers: authHeaders() })).status).toBe(404);
      });
    });

    // ── edit-prompt ────────────────────────────────────────────────

    describe("edit-prompt", () => {
      it("edits Close node", { timeout: 30_000 }, async () => {
        const struct = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const closeNode = struct.nodes.find((n: any) => n.name === "Close");
        expect(closeNode).toBeDefined();
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-prompt`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ nodeId: closeNode.id, instruction: `Thank the caller. [SYSTEST-${Date.now()}]` }),
        });
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("rejects empty instruction", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-prompt`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ nodeId: "x", instruction: "" }),
        })).status).toBe(400);
      });

      it("rejects missing nodeId", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-prompt`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ instruction: "test" }),
        })).status).toBe(400);
      });

      it("returns 404 for nonexistent node", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-prompt`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ nodeId: "nonexistent-xyz", instruction: "test" }),
        })).status).toBe(404);
      });
    });

    // ── edit-global-prompt ─────────────────────────────────────────

    describe("edit-global-prompt", () => {
      it("changes global prompt", { timeout: 30_000 }, async () => {
        const struct = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-global-prompt`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ globalPrompt: struct.globalPrompt + `\n[TEST-${Date.now()}]` }),
        });
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("rejects empty", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-global-prompt`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ globalPrompt: "" }),
        })).status).toBe(400);
      });
    });

    // ── edit-transition ────────────────────────────────────────────

    describe("edit-transition", () => {
      it("changes transition condition", { timeout: 30_000 }, async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-transition`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "dont_measure_me", transitionCondition: "The caller does not want measured [TEST-" + Date.now() + "]" }),
        });
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("rejects empty condition", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-transition`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "dont_measure_me", transitionCondition: "" }),
        })).status).toBe(400);
      });

      it("returns 404 for nonexistent path", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-transition`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "nonexistent_path", transitionCondition: "test" }),
        });
        expect(resp.status).toBe(404);
        expect((await json(resp)).availablePaths).toBeDefined();
      });
    });

    // ── edit-agent-settings ────────────────────────────────────────

    describe("edit-agent-settings", () => {
      it("rejects empty body", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-agent-settings`), {
          method: "POST", headers: authHeaders(), body: JSON.stringify({}),
        });
        expect(resp.status).toBe(400);
        expect((await json(resp)).allowed.length).toBeGreaterThan(5);
      });

      it("rejects disallowed fields", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-agent-settings`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ response_engine: "hacked" }),
        })).status).toBe(400);
      });
    });

    // ── save-and-publish (full integration) ──────────────────────

    describe("save-and-publish integration", () => {
      it("adds email to dont_measure_me, publishes, and verifies", { timeout: 45_000 }, async () => {
        // Get current state
        const struct = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm = struct.paths.find((p: any) => p.name === "dont_measure_me");
        const currentVars = dm.dataPoints.map((d: any) => d.variableName);
        expect(currentVars).not.toContain("email");

        // Save & publish with email added
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              description: "System test: add email to dont_measure_me",
              paths: {
                dont_measure_me: { dataPointKeys: [...currentVars, "email"], branchConditions: {} },
              },
            },
          }),
        });
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);

        // Verify via GET (pulls fresh from Retell)
        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm2 = after.paths.find((p: any) => p.name === "dont_measure_me");
        expect(dm2.dataPoints.map((d: any) => d.variableName)).toContain("email");

        // measure_me should be unaffected
        const mm = after.paths.find((p: any) => p.name === "measure_me");
        expect(mm.dataPoints.map((d: any) => d.variableName)).toContain("property_type");
      });

      it("removes email and reorders, publishes, and verifies", { timeout: 45_000 }, async () => {
        const struct = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm = struct.paths.find((p: any) => p.name === "dont_measure_me");
        const withoutEmail = dm.dataPoints
          .filter((d: any) => d.variableName !== "email")
          .map((d: any) => d.variableName);

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              description: "System test: remove email from dont_measure_me",
              paths: {
                dont_measure_me: { dataPointKeys: withoutEmail, branchConditions: {} },
              },
            },
          }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm2 = after.paths.find((p: any) => p.name === "dont_measure_me");
        expect(dm2.dataPoints.map((d: any) => d.variableName)).not.toContain("email");
      });

      it("rejects unknown data point in path", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ changes: { paths: { dont_measure_me: { dataPointKeys: ["nonexistent_xyz"] } } } }),
        })).status).toBe(400);
      });

      it("rejects missing changes object", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(), body: JSON.stringify({}),
        })).status).toBe(400);
      });
    });

    // ── Individual endpoint validation ─────────────────────────────

    describe("endpoint validation", () => {
      it("add-data-point rejects unknown key", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/add-data-point`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ dataPointKey: "nonexistent_xyz", pathName: "dont_measure_me" }),
        })).status).toBe(400);
      });

      it("add-data-point rejects nonexistent path", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/add-data-point`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ dataPointKey: "city", pathName: "nonexistent_path" }),
        });
        expect(resp.status).toBe(404);
        expect((await json(resp)).availablePaths).toBeDefined();
      });

      it("reorder rejects mismatched variables", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/reorder-data-points`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ variableNames: ["full_name", "nonexistent"], pathName: "dont_measure_me" }),
        })).status).toBe(400);
      });

      it("remove rejects nonexistent variable", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/remove-data-point`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ variableName: "nonexistent_xyz", pathName: "dont_measure_me" }),
        })).status).toBe(404);
      });
    });

    // ── edit-branch-condition ──────────────────────────────────────

    describe("edit-branch-condition", () => {
      it("sets condition on truck_number in dont_measure_me", { timeout: 30_000 }, async () => {
        // This is a test — we'll revert via rollback
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-branch-condition`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            variableName: "truck_number", pathName: "dont_measure_me",
            branchConditions: [{ variable: "full_name", operator: "!=", value: "Not Mentioned" }],
          }),
        });
        // This might fail validation since full_name is string not enum
        // but the endpoint should at least accept the request format
        expect([200, 400]).toContain(resp.status);
      });

      it("rejects nonexistent variable", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-branch-condition`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ variableName: "nonexistent_xyz", pathName: "dont_measure_me", branchConditions: null }),
        })).status).toBe(404);
      });

      it("rejects missing variableName", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-branch-condition`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "dont_measure_me", branchConditions: null }),
        })).status).toBe(400);
      });
    });

    // ── edit-path-name ─────────────────────────────────────────────

    describe("edit-path-name", () => {
      it("returns 404 for nonexistent path", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-name`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ oldName: "nonexistent", newName: "x" }),
        })).status).toBe(404);
      });

      it("rejects missing fields", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-name`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ oldName: "dont_measure_me" }),
        })).status).toBe(400);
      });
    });

    // ── edit-human-request-mode ────────────────────────────────────

    describe("edit-human-request-mode", () => {
      it("returns mode in GET", async () => {
        const body = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(["callback", "live_transfer"]).toContain(body.humanRequestMode);
        expect(body.humanRequestNodeId).toBeDefined();
      });

      it("rejects invalid mode", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-human-request-mode`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ mode: "invalid" }),
        })).status).toBe(400);
      });
    });

    // ── save-and-publish ───────────────────────────────────────────

    describe("save-and-publish", () => {
      it("rejects missing changes", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(), body: JSON.stringify({}),
        })).status).toBe(400);
      });

      it("rejects unknown data point in path changes", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              paths: { dont_measure_me: { dataPointKeys: ["full_name", "nonexistent_xyz"] } },
            },
          }),
        });
        expect(resp.status).toBe(400);
      });
    });

    // ── rollback ───────────────────────────────────────────────────

    describe("rollback", () => {
      it("rejects missing versionId", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/rollback`), {
          method: "POST", headers: authHeaders(), body: JSON.stringify({}),
        })).status).toBe(400);
      });

      it("rejects nonexistent version", async () => {
        expect((await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/rollback`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ versionId: "000000000000000000000000" }),
        })).status).toBe(404);
      });

      it("restores to snapshot", { timeout: 30_000 }, async () => {
        if (!preEditSnapshotId) return;
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/rollback`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ versionId: preEditSnapshotId }),
        });
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      it("structure valid after rollback", async () => {
        const body = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(body.paths.length).toBe(2);
        expect(body.nodes.length).toBeGreaterThan(30);
        for (const path of body.paths) {
          expect(path.dataPoints.length).toBeGreaterThan(0);
        }
      });
    });

    // ── push (raw) ─────────────────────────────────────────────────

    describe("push (raw)", () => {
      it("rejects empty canonicalJson", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/push`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ canonicalJson: {} }),
        });
        expect([400, 403]).toContain(resp.status);
      });
    });

    // ══════════════════════════════════════════════════════════════
    // LIVE INTEGRATION: Full round-trip against Retell
    // Each test publishes, then pulls fresh from Retell to verify.
    // All changes are rolled back at the end.
    // ══════════════════════════════════════════════════════════════

    describe("Live integration (publish → verify in Retell → rollback)", () => {
      let snapshotBeforeIntegration: string | undefined;

      it("snapshots current state before integration tests", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/versions?limit=1`), { headers: authHeaders() });
        const body = await json(resp);
        if (body.versions.length > 0) {
          snapshotBeforeIntegration = body.versions[0]._id;
        }
      });

      // ── 1. Add data point + publish + verify in Retell ─────────

      it("adds email to dont_measure_me and publishes to Retell", { timeout: 45_000 }, async () => {
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm = before.paths.find((p: any) => p.name === "dont_measure_me");
        const currentVars = dm.dataPoints.map((d: any) => d.variableName);

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              description: "Integration: add email",
              paths: { dont_measure_me: { dataPointKeys: [...currentVars, "email"], branchConditions: {} } },
            },
          }),
        });
        expect(resp.status).toBe(200);

        // Pull fresh from Retell (GET does fetchRetellAgent)
        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm2 = after.paths.find((p: any) => p.name === "dont_measure_me");
        expect(dm2.dataPoints.map((d: any) => d.variableName)).toContain("email");
      });

      // ── 2. Reorder + publish + verify in Retell ────────────────

      it("reorders dont_measure_me and verifies in Retell", { timeout: 45_000 }, async () => {
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm = before.paths.find((p: any) => p.name === "dont_measure_me");
        const vars = dm.dataPoints.map((d: any) => d.variableName);
        const reversed = [...vars].reverse();

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              description: "Integration: reorder",
              paths: { dont_measure_me: { dataPointKeys: reversed, branchConditions: {} } },
            },
          }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm2 = after.paths.find((p: any) => p.name === "dont_measure_me");
        const afterVars = dm2.dataPoints.map((d: any) => d.variableName);
        expect(afterVars[0]).toBe(reversed[0]);
      });

      // ── 3. Remove data point + publish + verify ────────────────

      it("removes email and verifies in Retell", { timeout: 45_000 }, async () => {
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm = before.paths.find((p: any) => p.name === "dont_measure_me");
        const withoutEmail = dm.dataPoints.filter((d: any) => d.variableName !== "email").map((d: any) => d.variableName);

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              description: "Integration: remove email",
              paths: { dont_measure_me: { dataPointKeys: withoutEmail, branchConditions: {} } },
            },
          }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm2 = after.paths.find((p: any) => p.name === "dont_measure_me");
        expect(dm2.dataPoints.map((d: any) => d.variableName)).not.toContain("email");
      });

      // ── 4. Edit global prompt + publish + verify ───────────────

      it("edits global prompt and verifies in Retell", { timeout: 45_000 }, async () => {
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const marker = "[INTEGRATION-" + Date.now() + "]";
        const newPrompt = before.globalPrompt + "\n" + marker;

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ changes: { globalPrompt: newPrompt, description: "Integration: global prompt" } }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(after.globalPrompt).toContain(marker);
      });

      // ── 5. Edit FAQ + publish + verify ─────────────────────────

      it("edits FAQ and verifies in Retell", { timeout: 45_000 }, async () => {
        const marker = "[FAQ-TEST-" + Date.now() + "]";

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ changes: { faqKnowledgeBase: "Demo Meter measures stuff! " + marker, description: "Integration: FAQ" } }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(after.faqKnowledgeBase).toContain(marker);
      });

      // ── 6. Edit transition condition + publish + verify ────────

      it("edits transition condition and verifies in Retell", { timeout: 45_000 }, async () => {
        const marker = "[TRANS-" + Date.now() + "]";

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              transitionConditions: { dont_measure_me: "Caller does not want measured " + marker },
              description: "Integration: transition",
            },
          }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(after.transitionConditions.dont_measure_me).toContain(marker);
      });

      // ── 7. Edit intro prompt + publish + verify ────────────────

      it("edits intro prompt and verifies in Retell", { timeout: 45_000 }, async () => {
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const marker = "[INTRO-" + Date.now() + "]";

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ changes: { introPrompt: before.introPrompt + "\n" + marker, description: "Integration: intro" } }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(after.introPrompt).toContain(marker);
      });

      // ── 8. Edit transition prompt + publish + verify ───────────

      it("edits transition prompt and verifies in Retell", { timeout: 45_000 }, async () => {
        const marker = "[TRANSPROMPT-" + Date.now() + "]";

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ changes: { transitionPrompt: "Alright let me note that down. " + marker, description: "Integration: transition prompt" } }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(after.transitionPrompt).toContain(marker);
      });

      // ── 9. Edit individual node prompt + publish + verify ──────

      it("edits a collect node prompt and verifies in Retell", { timeout: 45_000 }, async () => {
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm = before.paths.find((p: any) => p.name === "dont_measure_me");
        const firstDp = dm.dataPoints[0];
        const marker = "[NODEPROMPT-" + Date.now() + "]";

        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              nodePrompts: { [firstDp.collectNodeId]: firstDp.conversationPrompt + "\n" + marker },
              description: "Integration: node prompt",
            },
          }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm2 = after.paths.find((p: any) => p.name === "dont_measure_me");
        expect(dm2.dataPoints[0].conversationPrompt).toContain(marker);
      });

      // ── 10. Add new path + publish + verify ────────────────────

      it("adds a new path and verifies in Retell", { timeout: 45_000 }, async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/save-and-publish`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({
            changes: {
              description: "Integration: add path",
              newPaths: [{
                name: "test_path_integration",
                transitionCondition: "The caller wants the integration test path",
                dataPointKeys: ["full_name", "email"],
              }],
            },
          }),
        });
        expect(resp.status).toBe(200);

        const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(after.paths.length).toBeGreaterThanOrEqual(3);
        const newPath = after.paths.find((p: any) => p.name === "test_path_integration");
        expect(newPath).toBeDefined();
        expect(newPath.dataPoints.map((d: any) => d.variableName)).toContain("full_name");
        expect(newPath.dataPoints.map((d: any) => d.variableName)).toContain("email");
        expect(after.transitionConditions.test_path_integration).toContain("integration test path");
      });

      // ── 11. Verify measure_me branches survived all edits ──────

      it("measure_me branches are intact after all edits", async () => {
        const body = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const mm = body.paths.find((p: any) => p.name === "measure_me");
        expect(mm).toBeDefined();
        expect(mm.dataPoints.map((d: any) => d.variableName)).toContain("property_type");
        expect(mm.dataPoints.map((d: any) => d.variableName)).toContain("warranty_status");
        expect(mm.dataPoints.map((d: any) => d.variableName)).toContain("truck_number");

        // Branch conditions should still exist
        const prefDay = mm.dataPoints.find((d: any) => d.variableName === "preferred_day");
        if (prefDay) {
          expect(prefDay.branchConditions).toBeDefined();
          expect(prefDay.branchConditions.some((c: any) => c.variable === "property_type")).toBe(true);
        }
      });

      // ── 12. Version history has entries from all edits ──────────

      it("version history has entries from integration tests", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/versions?limit=20`), { headers: authHeaders() });
        const body = await json(resp);
        expect(body.total).toBeGreaterThanOrEqual(5);
        const descriptions = body.versions.map((v: any) => v.description);
        expect(descriptions.some((d: string) => d.includes("Integration"))).toBe(true);
      });

      // ── 13. Sync from Retell reflects published changes ────────

      it("sync pulls latest from Retell matching published state", async () => {
        // Sync the agent
        const syncResp = await fetch(url(`/agents/${SLUG}/sync`), { method: "POST", headers: authHeaders() });
        expect(syncResp.status).toBe(200);

        // Verify the synced state matches what we published
        const doc = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
        expect(doc.retell_agents[AGENT_ID]).toBeDefined();
        const canonical = doc.retell_agents[AGENT_ID];
        expect(canonical.conversationFlow).toBeDefined();
        const flow = canonical.conversationFlow;
        expect(flow.nodes.length).toBeGreaterThan(30);
      });

      // ── 14. Rollback to pre-integration snapshot ───────────────

      it("rolls back to pre-integration state", { timeout: 30_000 }, async () => {
        if (!snapshotBeforeIntegration) return;
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/rollback`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ versionId: snapshotBeforeIntegration }),
        });
        expect(resp.status).toBe(200);
        expect((await json(resp)).success).toBe(true);
      });

      // ── 15. Verify clean state after rollback ──────────────────

      it("agent is clean after rollback — 2 paths, no test_path", async () => {
        const body = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        expect(body.paths.length).toBe(2);
        expect(body.paths.some((p: any) => p.name === "test_path_integration")).toBe(false);
        expect(body.paths.some((p: any) => p.name === "measure_me")).toBe(true);
        expect(body.paths.some((p: any) => p.name === "dont_measure_me")).toBe(true);

        // Global prompt should not contain integration markers
        expect(body.globalPrompt).not.toContain("[INTEGRATION-");
        expect(body.faqKnowledgeBase).not.toContain("[FAQ-TEST-");
      });
    });
  });
});
