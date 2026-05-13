import "dotenv/config";
import { describe, it, expect, afterAll, beforeAll } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ROOT_PASSWORD = process.env.ROOT_PASSWORD;

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
  return "Basic " + Buffer.from(`admin:${ROOT_PASSWORD}`).toString("base64");
}

async function json(resp: Response): Promise<any> {
  return resp.json();
}

// ── Skip all tests if env vars are missing ──────────────────────────────────

const hasConfig = !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY;

describe.skipIf(!hasConfig)("System tests (Railway)", { timeout: 30_000 }, () => {
  let originalShadowMode: boolean | undefined;
  let originalHideNotMentioned: boolean | undefined;
  let originalActive: boolean | undefined;

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
    if (originalActive !== undefined) {
      await fetch(url(`/dashboard/api/agents/${SLUG}/active`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ active: originalActive }),
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
      expect(demo.agent_id).toBe(AGENT_ID);
    });

    it("returns full detail for Demo Team", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body._id).toBe(SLUG);
      expect(body.name).toContain("Demo Team");
      expect(body.agent_id).toBe(AGENT_ID);
      expect(body.message_types).toBeDefined();
      expect(Object.keys(body.message_types).length).toBeGreaterThanOrEqual(1);
      expect(body.retell_agents).toBeDefined();
      expect(body.retell_agents[AGENT_ID]).toBeDefined();
      originalShadowMode = body.shadow_mode;
      originalHideNotMentioned = body.hide_not_mentioned;
      originalActive = body.active;
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
      // Use J&A Fleet which has call overrides — use existing token to avoid invalidating client's portal link
      const jaToken = await (async () => {
        const getResp = await fetch(url("/dashboard/api/agents/j-a/portal-token"), { headers: authHeaders() });
        if (!getResp.ok) return null;
        const getBody = await json(getResp);
        if (getBody.has_token && getBody.portal_url) {
          return new URL(getBody.portal_url).searchParams.get("token");
        }
        // No existing token — generate one (safe since they didn't have one)
        const postResp = await fetch(url("/dashboard/api/agents/j-a/portal-token"), { method: "POST", headers: authHeaders() });
        if (!postResp.ok) return null;
        const postBody = await json(postResp);
        return new URL(postBody.portal_url).searchParams.get("token");
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
    let origDispatchTextNumbers: string[] | undefined;

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

      // Save original dispatch_text_numbers for restoration
      if (portalToken) {
        const agentResp = await fetch(url(`/portal/${SLUG}/api/agent?token=${portalToken}`));
        if (agentResp.ok) {
          const agentBody = await json(agentResp);
          origDispatchTextNumbers = agentBody.dispatch_text_numbers;
        }
      }
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

      // Restore original dispatch_text_numbers
      if (origDispatchTextNumbers) {
        await fetch(url(`/portal/${SLUG}/api/settings?token=${portalToken}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dispatch_text_numbers: origDispatchTextNumbers }),
        });
      }
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
        body: JSON.stringify({ shadow_mode: false, agent_id: "hacked" }),
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
        body: JSON.stringify({ username: testUser, password: "testpass123!", role: "viewer" }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).username).toBe(testUser);
    });
    it("rejects duplicate", async () => {
      expect((await fetch(url("/dashboard/api/users"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username: testUser, password: "testpass123!", role: "viewer" }),
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
    // Belt-and-suspenders: if any earlier `it` fails between create and delete,
    // ensure the test user is still removed.
    afterAll(async () => {
      await fetch(url(`/dashboard/api/users/${testUser}`), {
        method: "DELETE", headers: authHeaders(),
      });
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
    it("serves quick-create HTML with auth", async () => {
      const resp = await fetch(url("/quick-create"), { headers: { Authorization: basicAuthHeader() } });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toContain("Quick Create Agent");
    });
    it("/quick-create rejects without auth", async () => {
      expect((await fetch(url("/quick-create"))).status).toBe(401);
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
      // Capture id before asserting so afterAll can clean up regardless of status.
      if (resp.ok) draftId = (await json(resp))._id;
      expect(resp.status).toBe(200);
    });
    it("deletes draft", async () => {
      if (!draftId) return;
      expect((await fetch(url(`/form/drafts/${draftId}`), {
        method: "DELETE", headers: { Authorization: basicAuthHeader() },
      })).status).toBe(200);
    });
    afterAll(async () => {
      if (draftId) {
        await fetch(url(`/form/drafts/${draftId}`), {
          method: "DELETE", headers: { Authorization: basicAuthHeader() },
        });
      }
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
    // Unification regression: drafts and templates were collapsed; the route
    // is now /agents/from-draft. Old path is gone.
    it("rejects from-draft without draft field", async () => {
      const r = await fetch(url("/agents/from-draft"), { method: "POST", headers: authHeaders(), body: "{}" });
      expect(r.status).toBe(400);
      expect((await json(r)).error).toMatch(/draft/);
    });
    it("legacy /agents/from-template returns 404 (route removed)", async () => {
      const r = await fetch(url("/agents/from-template"), { method: "POST", headers: authHeaders(), body: "{}" });
      expect(r.status).toBe(404);
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
      // Save original category/sortOrder for full_name
      const origDp = await json(await fetch(url("/dashboard/api/data-point-defaults"), { headers: authHeaders() }));
      const origFullName = origDp.defaults?.full_name;
      const origCat = origFullName?.category || "caller_info";
      const origSort = origFullName?.sortOrder ?? 0;

      const resp = await fetch(url("/dashboard/api/data-point-defaults/reorder"), {
        method: "PUT", headers: authHeaders(),
        body: JSON.stringify({ items: [{ key: "full_name", category: "general", sortOrder: 99 }] }),
      });
      expect(resp.status).toBe(200);

      // Restore original
      await fetch(url("/dashboard/api/data-point-defaults/reorder"), {
        method: "PUT", headers: authHeaders(),
        body: JSON.stringify({ items: [{ key: "full_name", category: origCat, sortOrder: origSort }] }),
      });
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

    // Bad-body validation paths added in the system-test gap-fill sweep.
    // These don't create state, so they don't need their own cleanup.

    it("POST rejects missing key", async () => {
      const resp = await fetch(url("/dashboard/api/data-point-defaults"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ label: "no key" }),
      });
      expect(resp.status).toBe(400);
      expect((await json(resp)).error).toMatch(/key/);
    });

    it("POST rejects missing label", async () => {
      const resp = await fetch(url("/dashboard/api/data-point-defaults"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ key: "_systest_no_label_" + Date.now() }),
      });
      expect(resp.status).toBe(400);
      expect((await json(resp)).error).toMatch(/label/);
    });

    it("PUT reorder rejects non-array items", async () => {
      const resp = await fetch(url("/dashboard/api/data-point-defaults/reorder"), {
        method: "PUT", headers: authHeaders(),
        body: JSON.stringify({ items: "not-an-array" }),
      });
      expect(resp.status).toBe(400);
    });

    // Belt-and-suspenders: the explicit DELETE `it` may not run if an earlier
    // test threw. Always try to remove the captured key.
    afterAll(async () => {
      if (createdKey) {
        await fetch(url(`/dashboard/api/data-point-defaults/${createdKey}`), {
          method: "DELETE", headers: authHeaders(),
        });
      }
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
    });

    afterAll(async () => {
      // Restore the original portal_sms_message regardless of whether the
      // verify assertion above threw.
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
    let origOrder: unknown;
    let origCaptured = false;

    it("saves and retrieves category_order", async () => {
      // Save original
      const orig = await json(await fetch(url("/dashboard/api/settings"), { headers: authHeaders() }));
      origOrder = orig.category_order;
      origCaptured = true;

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
    });

    afterAll(async () => {
      // Restore original (not null — preserve user's settings) regardless of
      // whether the assertions above threw.
      if (origCaptured) {
        await fetch(url("/dashboard/api/settings"), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ category_order: origOrder ?? null }),
        });
      }
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
    // Hoisted so the afterAll hook below can clean up the test user even if
    // the inline DELETE inside `it("super_admin role accepted...")` doesn't
    // run (e.g. because an earlier `expect` in that `it` threw).
    const superAdminTestUser = "_systest_super_" + Date.now();

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
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username: superAdminTestUser, password: "testpass123!", role: "super_admin" }),
      });
      expect(resp.status).toBe(200);
      // Clean up (afterAll repeats this as a safety net if the assertion threw)
      await fetch(url(`/dashboard/api/users/${superAdminTestUser}`), { method: "DELETE", headers: authHeaders() });
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

    afterAll(async () => {
      // Idempotent: 404 if already deleted by the inline cleanup above.
      await fetch(url(`/dashboard/api/users/${superAdminTestUser}`), {
        method: "DELETE", headers: authHeaders(),
      });
    });
  });

  // ── 23b. Export Agent Config ──────────────────────────────────────

  describe("Export agent config", () => {
    it("exports Demo Meter config as valid JSON", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/export`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const config = await json(resp);

      // Verify structure matches servicecall-agent-config format
      expect(config.version).toBe(1);
      expect(config.type).toBe("servicecall-agent-config");
      expect(typeof config.exportedAt).toBe("string");

      // Business config
      expect(config.business).toBeDefined();
      expect(typeof config.business.businessName).toBe("string");
      expect(config.business.businessName.length).toBeGreaterThan(0);
      expect(typeof config.business.faqKnowledgeBase).toBe("string");
      expect(["callback", "live_transfer"]).toContain(config.business.human_request_mode);

      // Paths with data points
      expect(Array.isArray(config.paths)).toBe(true);
      expect(config.paths.length).toBeGreaterThan(0);
      for (const path of config.paths) {
        expect(typeof path.name).toBe("string");
        expect(typeof path.transitionCondition).toBe("string");
        expect(Array.isArray(path.dataPoints)).toBe(true);
        expect(path.dataPoints.length).toBeGreaterThan(0);
        for (const dp of path.dataPoints) {
          expect(dp.variableName).toBeDefined();
          expect(typeof dp.variableName).toBe("string");
        }
      }

      // Client config
      expect(config.client).toBeDefined();
      expect(config.client.slug).toBe(SLUG);
      expect(Array.isArray(config.client.dispatch_text_numbers)).toBe(true);
    });

    it("exported config is compatible with /agents/create format", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/export`), { headers: authHeaders() });
      const config = await json(resp);

      // The exported JSON should have the fields needed by CreateAgentBody
      expect(config.business.businessName).toBeDefined();
      expect(config.business.faqKnowledgeBase).toBeDefined();
      expect(config.paths.length).toBeGreaterThan(0);
      for (const path of config.paths) {
        expect(path.name).toBeDefined();
        expect(path.transitionCondition).toBeDefined();
        expect(path.dataPoints.length).toBeGreaterThan(0);
      }
      expect(config.client.dispatch_text_numbers.length).toBeGreaterThan(0);
    });

    it("returns 404 for nonexistent agent", async () => {
      expect((await fetch(url("/dashboard/api/agents/nonexistent-xyz/export"), { headers: authHeaders() })).status).toBe(404);
    });

    it("exported paths match node editor structure", async () => {
      const [exportResp, nodeResp] = await Promise.all([
        fetch(url(`/dashboard/api/agents/${SLUG}/export`), { headers: authHeaders() }),
        fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }),
      ]);
      const config = await json(exportResp);
      const nodeData = await json(nodeResp);

      // Same number of paths
      expect(config.paths.length).toBe(nodeData.paths.length);

      // Path names match
      const exportNames = config.paths.map((p: any) => p.name).sort();
      const nodeNames = nodeData.paths.map((p: any) => p.name).sort();
      expect(exportNames).toEqual(nodeNames);

      // Data point counts match per path
      for (const ep of config.paths) {
        const np = nodeData.paths.find((p: any) => p.name === ep.name);
        if (np) {
          expect(ep.dataPoints.length).toBe(np.dataPoints.length);
        }
      }
    });

    it("export also works via API key route", async () => {
      const resp = await fetch(url(`/agents/${SLUG}/export`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const config = await json(resp);
      expect(config.version).toBe(1);
      expect(config.type).toBe("servicecall-agent-config");
    });
  });

  // ── 23c. Settings — category_labels ─────────────────────────────────

  describe("Settings category_labels", () => {
    let origLabels: unknown;
    let origCaptured = false;

    it("saves and retrieves custom category labels", async () => {
      // Save original
      const orig = await json(await fetch(url("/dashboard/api/settings"), { headers: authHeaders() }));
      origLabels = orig.category_labels;
      origCaptured = true;

      const labels = { ...(origLabels as Record<string, unknown> | null || {}), _systest_cat: "System Test Category" };
      const patchResp = await fetch(url("/dashboard/api/settings"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ category_labels: labels }),
      });
      expect(patchResp.status).toBe(200);

      const verify = await json(await fetch(url("/dashboard/api/settings"), { headers: authHeaders() }));
      expect(verify.category_labels._systest_cat).toBe("System Test Category");

      // Verify data-point-defaults returns merged labels
      const dpResp = await json(await fetch(url("/dashboard/api/data-point-defaults"), { headers: authHeaders() }));
      expect(dpResp.categoryLabels._systest_cat).toBe("System Test Category");
      expect(dpResp.categoryLabels.caller_info).toBeDefined();
    });

    afterAll(async () => {
      // Restore original (remove the test key) regardless of assertion outcome.
      if (origCaptured) {
        await fetch(url("/dashboard/api/settings"), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ category_labels: origLabels ?? null }),
        });
      }
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

      it("returns the parsed snapshot shape for a real versionId", async () => {
        if (!preEditSnapshotId) return; // list endpoint returned empty — nothing to fetch
        const resp = await fetch(
          url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/versions/${preEditSnapshotId}`),
          { headers: authHeaders() },
        );
        expect(resp.status).toBe(200);
        const body = await json(resp);
        // The endpoint returns a derived/parsed view, not the raw
        // canonicalJson — assert the fields the rollback UI actually
        // displays (paths, prompts, counts) so a regression here surfaces.
        expect(body._id).toBe(preEditSnapshotId);
        expect(typeof body.nodeCount).toBe("number");
        expect(body.source).toBeDefined();
        expect(typeof body.globalPrompt).toBe("string");
        expect(Array.isArray(body.paths)).toBe(true);
        expect(body.paths.length).toBeGreaterThan(0);
      });
    });

    // ── edit-prompt ────────────────────────────────────────────────

    describe("edit-prompt", () => {
      it("edits Close node", { timeout: 30_000 }, async () => {
        const struct = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        // Multi-path agents have "Close (pathName)" nodes; single-path agents
        // keep the legacy singleton "Close". Accept either.
        const closeNode = struct.nodes.find((n: any) =>
          n.name === "Close" || (typeof n.name === "string" && n.name.startsWith("Close ("))
        );
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

      it("persists an allowlisted field round-trip and restores it", { timeout: 30_000 }, async () => {
        // Capture original voice_speed from the Mongo-cached canonical
        // (the node-editor GET writes the freshest Retell snapshot to
        // doc.retell_agents[agentId] on every read, so this is current).
        const docResp = await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() });
        const doc = await json(docResp);
        const original = doc.retell_agents?.[AGENT_ID]?.voice_speed as number | undefined;
        // Pick a probe value that's definitely different and within
        // Retell's accepted range (0.5–2.0).
        const probe = original === 1.05 ? 1.10 : 1.05;
        try {
          const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-agent-settings`), {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({ voice_speed: probe }),
          });
          expect(resp.status).toBe(200);
          const respBody = await json(resp);
          expect(respBody.success).toBe(true);
          expect(respBody.updated).toContain("voice_speed");

          // The route calls retell.agent.update + storeCanonical, so the
          // Mongo doc reflects the new value.
          const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
          expect(after.retell_agents?.[AGENT_ID]?.voice_speed).toBe(probe);
        } finally {
          if (original !== undefined) {
            await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-agent-settings`), {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({ voice_speed: original }),
            });
          }
        }
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
      it("clears the branch condition on truck_number end-to-end and restores", { timeout: 30_000 }, async () => {
        // Capture the live branch state on truck_number — don't assume
        // a specific shape (operator changes the matrix over time).
        // Then clear it (branchConditions: null), verify, restore.
        // Clearing is the cleanest round-trip because it's a no-op when
        // already null AND when not, so the restore is safe to retry.
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const dm = before.paths.find((p: any) => p.name === "dont_measure_me");
        const truck = dm?.dataPoints.find((d: any) => d.variableName === "truck_number");
        expect(truck).toBeDefined();
        const original = truck.branchConditions ?? null;

        let mutated = false;
        try {
          const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-branch-condition`), {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({
              variableName: "truck_number", pathName: "dont_measure_me",
              branchConditions: null,
            }),
          });
          expect(resp.status).toBe(200);
          expect((await json(resp)).success).toBe(true);
          mutated = true;

          const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
          const dm2 = after.paths.find((p: any) => p.name === "dont_measure_me");
          const truck2 = dm2.dataPoints.find((d: any) => d.variableName === "truck_number");
          // After clearing, the variable should still exist but have no
          // branch attached.
          expect(truck2.branchConditions ?? null).toBeNull();
        } finally {
          if (mutated && original !== null) {
            await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-branch-condition`), {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({
                variableName: "truck_number", pathName: "dont_measure_me",
                branchConditions: original,
              }),
            });
          }
        }
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

      it("renames a path end-to-end and restores it", { timeout: 30_000 }, async () => {
        // edit-path-name updates Mongo only (message_types,
        // dispatch_by_type, path_end_modes, and the cached canonical) —
        // it does NOT push to Retell, so we verify against the Mongo
        // doc rather than the node-editor's GET (which pulls from
        // Retell). This catches regressions where one of the doc
        // fields fails to update while the others do.
        const probeName = `dont_measure_me_systest_${Date.now()}`;
        let renamed = false;
        try {
          const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-name`), {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({ oldName: "dont_measure_me", newName: probeName }),
          });
          expect(resp.status).toBe(200);
          expect((await json(resp)).success).toBe(true);
          renamed = true;

          // Read the Mongo-side state via the dashboard's main agent
          // endpoint (returns the client doc directly without re-pulling
          // from Retell, which would clobber the rename).
          // The handler always updates the cached canonical
          // (retell_agents.<id>) — message_types/dispatch_by_type are
          // only touched if those fields already existed on the doc, so
          // we verify against the canonical's renamed node names which
          // are the unconditional side-effect.
          const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
          const cachedCanonical = after.retell_agents?.[AGENT_ID];
          expect(cachedCanonical).toBeDefined();
          const cachedNodes = (cachedCanonical?.conversationFlow?.nodes ?? []) as Array<{ name?: string }>;
          // At least one node's display name encodes the path suffix
          // (e.g. "Close (probeName)"). The handler rewrites every
          // " (oldName)" suffix to " (newName)".
          const renamedNode = cachedNodes.find((n) => typeof n.name === "string" && n.name.includes(`(${probeName})`));
          expect(renamedNode).toBeDefined();
          // And no node still bears the old suffix.
          const stragglerNode = cachedNodes.find((n) => typeof n.name === "string" && n.name.includes("(dont_measure_me)"));
          expect(stragglerNode).toBeUndefined();
        } finally {
          if (renamed) {
            await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-name`), {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({ oldName: probeName, newName: "dont_measure_me" }),
            });
          }
        }
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

      it("flips the mode end-to-end and verifies via response body", { timeout: 30_000 }, async () => {
        // edit-human-request-mode writes the modified canonical to Mongo
        // via storeCanonical, but does NOT push to Retell. The
        // node-editor GET pulls fresh from Retell, so it won't reflect
        // the change. The most reliable verification is the route's
        // own response body — assert there and trust the audit-log
        // entry as the persistence record.
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const original = before.humanRequestMode as "callback" | "live_transfer";
        const probe: "callback" | "live_transfer" = original === "callback" ? "live_transfer" : "callback";

        let flipped = false;
        try {
          const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-human-request-mode`), {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({ mode: probe }),
          });
          expect(resp.status).toBe(200);
          const body = await json(resp);
          expect(body.success).toBe(true);
          expect(body.mode).toBe(probe);
          flipped = true;
        } finally {
          if (flipped) {
            await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-human-request-mode`), {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({ mode: original }),
            });
          }
        }
      });
    });

    // ── edit-path-end-mode ────────────────────────────────────────

    describe("edit-path-end-mode", () => {
      it("rejects missing pathName", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-end-mode`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ mode: "callback" }),
        });
        expect(resp.status).toBe(400);
      });

      it("rejects invalid mode", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-end-mode`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "measure_me", mode: "bogus" }),
        });
        expect(resp.status).toBe(400);
      });

      it("rejects mode missing entirely", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-end-mode`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "measure_me" }),
        });
        expect(resp.status).toBe(400);
      });

      it("returns 404 for nonexistent path on a real agent", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-end-mode`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "nonexistent_path_xyz", mode: "callback" }),
        });
        expect(resp.status).toBe(404);
      });

      it("returns 404 for nonexistent agent", async () => {
        const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/agent_nonexistent_xyz/edit-path-end-mode`), {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ pathName: "measure_me", mode: "callback" }),
        });
        expect(resp.status).toBe(404);
      });

      it("flips mode for measure_me end-to-end and restores", { timeout: 45_000 }, async () => {
        // path-end-mode is the riskiest mutation in this suite — flipping
        // it adds/removes Pre-Transfer + Transfer Call nodes. The route
        // DOES push to Retell (unlike edit-path-name), so a fresh GET
        // reflects the change. Try/finally restores; the suite-level
        // rollback at the end is the second safety net.
        //
        // Note: this route uses "callback"/"transfer", whereas the
        // node-parser exposes endMode as "callback"/"transfer" (same
        // strings). Different from edit-human-request-mode which uses
        // "callback"/"live_transfer".
        const before = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
        const measureMe = before.paths.find((p: any) => p.name === "measure_me");
        expect(measureMe).toBeDefined();
        const original = measureMe.endMode as "callback" | "transfer";
        const probe: "callback" | "transfer" = original === "callback" ? "transfer" : "callback";
        const beforeNodeCount = before.nodes.length;

        let flipped = false;
        try {
          const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-end-mode`), {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({ pathName: "measure_me", mode: probe }),
          });
          expect(resp.status).toBe(200);
          expect((await json(resp)).success).toBe(true);
          flipped = true;

          const after = await json(await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}`), { headers: authHeaders() }));
          const afterPath = after.paths.find((p: any) => p.name === "measure_me");
          expect(afterPath.endMode).toBe(probe);
          // Node count should change because Transfer Call + Pre-Transfer
          // nodes are added/removed depending on direction. Don't assert
          // a specific delta (skill flow may evolve) — just that something
          // moved structurally.
          expect(after.nodes.length).not.toBe(beforeNodeCount);
        } finally {
          if (flipped) {
            await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/edit-path-end-mode`), {
              method: "POST", headers: authHeaders(),
              body: JSON.stringify({ pathName: "measure_me", mode: original }),
            });
          }
        }
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

      // Belt-and-suspenders: if the rollback `it` above failed (or its
      // snapshotBeforeIntegration was never captured), this hook makes one
      // more attempt to restore the agent. Idempotent — replaying the same
      // versionId into rollback is safe.
      afterAll(async () => {
        if (!snapshotBeforeIntegration) return;
        try {
          await fetch(url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/rollback`), {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({ versionId: snapshotBeforeIntegration }),
          });
        } catch { /* best-effort */ }
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Webhooks — auth/validation only (no real dispatch)
  // ══════════════════════════════════════════════════════════════════════════

  describe("Webhooks", () => {
    describe("Retell pre-hook", () => {
      it("rejects missing x-retell-signature with 401", async () => {
        const resp = await fetch(url("/retell/pre-hook"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: "call_inbound", call_inbound: {} }),
        });
        expect(resp.status).toBe(401);
        const body = await json(resp);
        expect(body.outcome).toBe("missing_signature_header");
      });

      it("rejects invalid signature with 401", async () => {
        const resp = await fetch(url("/retell/pre-hook"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-retell-signature": "v=1726000000,d=deadbeef",
          },
          body: JSON.stringify({ event: "call_inbound", call_inbound: {} }),
        });
        expect(resp.status).toBe(401);
        expect((await json(resp)).outcome).toBe("invalid_signature");
      });
    });

    describe("Retell post-hook", () => {
      it("rejects missing x-retell-signature with 401", async () => {
        const resp = await fetch(url("/retell/post-hook"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event: "call_ended", call: { agent_id: "agent_unknown" } }),
        });
        expect(resp.status).toBe(401);
      });

      it("rejects invalid signature with 401", async () => {
        const resp = await fetch(url("/retell/post-hook"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-retell-signature": "v=1726000000,d=baadcafe",
          },
          body: JSON.stringify({ event: "call_ended", call: { agent_id: "agent_unknown" } }),
        });
        expect(resp.status).toBe(401);
      });

      it("internal API key bypasses signature and processes ignored events", async () => {
        const resp = await fetch(url("/retell/post-hook"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": API_KEY!,
          },
          body: JSON.stringify({ event: "call_started" }),
        });
        expect(resp.status).toBe(200);
        const body = await json(resp);
        expect(body.outcome).toBe("ignored_event");
        expect(body.event).toBe("call_started");
      });

      it("internal API key bypasses signature and 400s on missing call object", async () => {
        const resp = await fetch(url("/retell/post-hook"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": API_KEY!,
          },
          body: JSON.stringify({ event: "call_ended" }),
        });
        expect(resp.status).toBe(400);
      });
    });

  });

  // ══════════════════════════════════════════════════════════════════════════
  // Agent delete lifecycle — validation/404 paths only.
  // We deliberately avoid running destructive ops against real agents.
  // ══════════════════════════════════════════════════════════════════════════

  describe("Agent delete lifecycle (validation)", () => {
    it("DELETE /dashboard/api/agents/:slug returns 404 for nonexistent slug", async () => {
      const resp = await fetch(url("/dashboard/api/agents/nonexistent-delete-xyz"), {
        method: "DELETE", headers: authHeaders(),
      });
      expect(resp.status).toBe(404);
    });

    it("DELETE without API key is rejected (401)", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "DELETE",
      });
      expect(resp.status).toBe(401);
    });

    it("POST /dashboard/api/deleted-agents/:slug/restore handles nonexistent slug", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents/nonexistent-restore-xyz/restore"), {
        method: "POST", headers: authHeaders(),
      });
      // Accept either 404 (explicit) or 500 (unhandled — restoreClient may throw)
      expect([404, 500]).toContain(resp.status);
    });

    it("POST restore without auth is rejected", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents/anything/restore"), {
        method: "POST",
      });
      expect(resp.status).toBe(401);
    });

    it("DELETE /dashboard/api/deleted-agents/:slug handles nonexistent slug gracefully", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents/nonexistent-perma-xyz"), {
        method: "DELETE", headers: authHeaders(),
      });
      // Permanent-delete on a missing doc may succeed (no-op) or 404/500.
      expect([200, 404, 500]).toContain(resp.status);
    });

    it("permanent-delete without auth is rejected", async () => {
      const resp = await fetch(url("/dashboard/api/deleted-agents/anything"), {
        method: "DELETE",
      });
      expect(resp.status).toBe(401);
    });
  });

  // ── 26. Display Name (Retell sync) ─────────────────────────────────────────
  // PATCH display_name should update Mongo, return success, and report that
  // the Retell-side push (agent.agent_name + phone-number nicknames) ran.
  // Each test restores the prior value so the shared Demo Meter agent is
  // left exactly as it was found.

  describe("Display name (Retell sync)", { timeout: 30_000 }, () => {
    let originalDisplayName: string | null | undefined;

    it("captures original display_name", async () => {
      const doc = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
      originalDisplayName = doc.display_name ?? null;
    });

    it("PATCH display_name updates Mongo and reports a Retell sync", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ display_name: "Demo Meter (system-test)" }),
      });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.doc.display_name).toBe("Demo Meter (system-test)");
      // Server returns display_sync metadata when it pushed to Retell.
      expect(body.display_sync?.agentNameUpdated).toBe(true);
    });

    it("dashboard list reflects the new display_name", async () => {
      const list = await json(await fetch(url("/dashboard/api/agents"), { headers: authHeaders() }));
      const row = list.find((a: any) => a.slug === SLUG);
      expect(row?.display_name).toBe("Demo Meter (system-test)");
    });

    it("clearing display_name (empty string → null) falls back to business name", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ display_name: "" }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).doc.display_name).toBeNull();
    });

    it("rejects non-string non-null display_name with 400", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ display_name: 42 }),
      });
      expect(resp.status).toBe(400);
    });

    afterAll(async () => {
      if (originalDisplayName !== undefined) {
        await fetch(url(`/dashboard/api/agents/${SLUG}`), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ display_name: originalDisplayName }),
        });
      }
    });
  });

  // ── 27. Rename Business (script-only contract) ────────────────────────────
  // The rename flow rewrites prompts/flow text + Mongo `name`, and (per the
  // new contract) does NOT push agent_name to Retell or update phone-number
  // nicknames — those are owned by display_name. Cleanup is a second
  // rename-business call that restores the original name.

  describe("Rename business (script-only contract)", { timeout: 60_000 }, () => {
    let originalName: string | undefined;
    let tempName: string | undefined;

    it("captures original business name", async () => {
      const doc = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
      originalName = doc.name;
      expect(typeof originalName).toBe("string");
    });

    it("rename rewrites script + Mongo without reporting nickname work", async () => {
      tempName = `${originalName} TEMP-${Date.now()}`;
      const resp = await fetch(
        url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/rename-business`),
        {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ newName: tempName, oldName: originalName }),
        },
      );
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.success).toBe(true);
      expect(body.oldName).toBe(originalName);
      expect(body.newName).toBe(tempName);
      // New contract: response no longer carries nickname_updated/nickname_errors.
      expect(body.nickname_updated).toBeUndefined();
      expect(body.nickname_errors).toBeUndefined();

      // Mongo name updated.
      const doc = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
      expect(doc.name).toBe(tempName);
    });

    afterAll(async () => {
      // Restore by renaming back. Re-read the current name in case the test
      // above failed mid-flight, so we always use a correct oldName.
      if (!originalName) return;
      const doc = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
      if (doc.name === originalName) return;
      await fetch(
        url(`/dashboard/api/agents/${SLUG}/nodes/${AGENT_ID}/rename-business`),
        {
          method: "POST", headers: authHeaders(),
          body: JSON.stringify({ newName: originalName, oldName: doc.name }),
        },
      );
    });
  });

  // ── 28. Folders CRUD + agent move ─────────────────────────────────────────
  // Creates a temp folder, lists it, moves the test agent in, then in afterAll
  // restores the agent's original folder and deletes the temp folder.

  describe("Folders CRUD + agent move", { timeout: 30_000 }, () => {
    let testFolderId: string | undefined;
    let originalFolderId: string | null | undefined;

    // Sweep any orphan `_systest_*` folders left behind by prior failed runs
    // before we create a new one — keeps the dashboard clean even when a
    // previous run's afterAll didn't fire.
    beforeAll(async () => {
      try {
        const resp = await fetch(url("/dashboard/api/folders"), { headers: authHeaders() });
        if (!resp.ok) return;
        const folders = await json(resp);
        for (const f of folders) {
          if (typeof f?.name === "string" && f.name.startsWith("_systest_")) {
            await fetch(url(`/dashboard/api/folders/${f._id}`), {
              method: "DELETE", headers: authHeaders(),
            });
          }
        }
      } catch { /* best-effort sweep; failures here shouldn't block the suite */ }
    });

    it("captures Demo Meter's current folder", async () => {
      const doc = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
      originalFolderId = doc.folder_id ?? null;
    });

    it("creates a test folder", async () => {
      const resp = await fetch(url("/dashboard/api/folders"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ name: `_systest_${Date.now()}` }),
      });
      // Capture id BEFORE the status assertion so the afterAll can clean up
      // even when the status doesn't match expectations.
      if (resp.ok) {
        const body = await json(resp);
        testFolderId = body._id ?? body.id;
      }
      expect(resp.status).toBe(201);
      expect(testFolderId).toBeTruthy();
    });

    it("lists the new folder", async () => {
      const folders = await json(await fetch(url("/dashboard/api/folders"), { headers: authHeaders() }));
      expect(Array.isArray(folders)).toBe(true);
      expect(folders.some((f: any) => f._id === testFolderId)).toBe(true);
    });

    it("moves Demo Meter into the test folder", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/folder`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ folder_id: testFolderId }),
      });
      expect(resp.status).toBe(200);
      const doc = await json(await fetch(url(`/dashboard/api/agents/${SLUG}`), { headers: authHeaders() }));
      expect(doc.folder_id).toBe(testFolderId);
    });

    afterAll(async () => {
      // Restore folder_id first so the temp folder is empty when we delete it.
      if (originalFolderId !== undefined) {
        await fetch(url(`/dashboard/api/agents/${SLUG}/folder`), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ folder_id: originalFolderId }),
        });
      }
      if (testFolderId) {
        await fetch(url(`/dashboard/api/folders/${testFolderId}`), {
          method: "DELETE", headers: authHeaders(),
        });
      }
    });
  });

  // ── 29. Phone numbers list ────────────────────────────────────────────────
  // Read-only — no cleanup needed.

  describe("Phone numbers list", () => {
    it("GET /dashboard/api/phone-numbers returns the byAgent map", async () => {
      const resp = await fetch(url("/dashboard/api/phone-numbers"), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      expect(body.byAgent).toBeDefined();
      expect(typeof body.byAgent).toBe("object");
    });
  });

  // ── 30. Folder rename + reposition ───────────────────────────────────────
  // Mutation tests on a temp folder. afterAll deletes the folder. The
  // existing Section 28 beforeAll sweep also picks up `_systest_*` orphans
  // on the next run as a second line of defence.

  describe("Folder rename + reposition", { timeout: 30_000 }, () => {
    let testFolderId: string | undefined;

    it("creates a temp folder for the rename/reposition tests", async () => {
      const resp = await fetch(url("/dashboard/api/folders"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ name: `_systest_rename_${Date.now()}` }),
      });
      // Capture id before asserting status so afterAll can clean up even if
      // the assertion throws.
      if (resp.ok) testFolderId = (await json(resp))._id;
      expect(resp.status).toBe(201);
      expect(testFolderId).toBeTruthy();
    });

    it("PATCH /folders/:id renames", async () => {
      if (!testFolderId) return;
      const newName = `_systest_renamed_${Date.now()}`;
      const resp = await fetch(url(`/dashboard/api/folders/${testFolderId}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ name: newName }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).name).toBe(newName);
    });

    it("PATCH /folders/:id repositions", async () => {
      if (!testFolderId) return;
      const resp = await fetch(url(`/dashboard/api/folders/${testFolderId}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ position: 99999 }),
      });
      expect(resp.status).toBe(200);
      expect((await json(resp)).position).toBe(99999);
    });

    it("PATCH /folders/:id rejects whitespace-only name", async () => {
      if (!testFolderId) return;
      const resp = await fetch(url(`/dashboard/api/folders/${testFolderId}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ name: "   " }),
      });
      expect(resp.status).toBe(400);
    });

    it("PATCH /folders/:id rejects body with no supported fields", async () => {
      if (!testFolderId) return;
      const resp = await fetch(url(`/dashboard/api/folders/${testFolderId}`), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ unsupported: "x" }),
      });
      expect(resp.status).toBe(400);
    });

    it("PATCH /folders/:id rejects malformed ObjectId", async () => {
      const resp = await fetch(url("/dashboard/api/folders/notanobjectid"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ name: "x" }),
      });
      expect(resp.status).toBe(400);
    });

    afterAll(async () => {
      if (testFolderId) {
        await fetch(url(`/dashboard/api/folders/${testFolderId}`), {
          method: "DELETE", headers: authHeaders(),
        });
      }
    });
  });

  // ── 31. Calls list — pagination + filters ────────────────────────────────
  // Read-only against an existing slug; no cleanup needed.

  describe("Calls list — pagination + filters", () => {
    it("clamps limit > 100 down to 100", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=999`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const calls = await json(resp);
      expect(Array.isArray(calls)).toBe(true);
      expect(calls.length).toBeLessThanOrEqual(100);
    });

    it("respects offset (page1 and page2 differ when there are enough calls)", async () => {
      const [page1, page2] = await Promise.all([
        fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=2&offset=0`), { headers: authHeaders() }).then(json),
        fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=2&offset=2`), { headers: authHeaders() }).then(json),
      ]);
      // Only assert difference when both pages actually returned call_id-bearing rows.
      // Demo Meter's call log can be sparse; skip the comparison when it is.
      if (Array.isArray(page1) && Array.isArray(page2) && page1[0]?.call_id && page2[0]?.call_id) {
        expect(page2[0].call_id).not.toBe(page1[0].call_id);
      }
    });

    it("include_tests=1 never returns fewer rows than the default", async () => {
      const without = await fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=50`), { headers: authHeaders() }).then(json);
      const withTests = await fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=50&include_tests=1`), { headers: authHeaders() }).then(json);
      expect(withTests.length).toBeGreaterThanOrEqual(without.length);
    });

    it("garbage limit falls back to default (≤ 50)", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/calls?limit=abc`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const calls = await json(resp);
      expect(calls.length).toBeLessThanOrEqual(50);
    });
  });

  // ── 32. Billing COGS ─────────────────────────────────────────────────────
  // Read-only.

  describe("Billing COGS", () => {
    it("GET /billing/cogs/:slug returns the ClientCogsResponse shape", async () => {
      const resp = await fetch(url(`/dashboard/api/billing/cogs/${SLUG}`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      // Shape pinned to ClientCogsResponse in src/lib/billing-cogs.ts.
      expect(body.client_slug).toBe(SLUG);
      expect(body.rates).toBeDefined();
      expect(body.current).toBeDefined();
      expect(typeof body.current.month).toBe("string");
      expect(typeof body.current.total_cents).toBe("number");
      expect(Array.isArray(body.history)).toBe(true);
    });

    it("respects months query param (clamped to [1, 24])", async () => {
      const resp = await fetch(url(`/dashboard/api/billing/cogs/${SLUG}?months=999`), { headers: authHeaders() });
      expect(resp.status).toBe(200);
      const body = await json(resp);
      // history length is bounded by months requested (≤ 24).
      expect(body.history.length).toBeLessThanOrEqual(24);
    });
  });

  // ── 33. Settings PATCH — type-mismatch rejection paths ──────────────────
  // The handler delegates validation to updateSettings(), so the rejection
  // surfaces from the lib. Capture the value we touch and restore in afterAll
  // so a non-200 response can never leave the global setting in a bad state.

  describe("Settings PATCH — rejections", () => {
    let origPortalMsg: string | undefined;
    let origCaptured = false;

    it("captures current portal_sms_message", async () => {
      const settings = await json(await fetch(url("/dashboard/api/settings"), { headers: authHeaders() }));
      origPortalMsg = settings.portal_sms_message;
      origCaptured = true;
    });

    it("rejects non-string for portal_sms_message", async () => {
      const resp = await fetch(url("/dashboard/api/settings"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ portal_sms_message: 42 }),
      });
      // updateSettings() type-checks; status is 400 or 500 depending on impl.
      expect([400, 500]).toContain(resp.status);
    });

    it("rejects unknown field shape that updateSettings rejects", async () => {
      const resp = await fetch(url("/dashboard/api/settings"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ category_order: "not-an-array" }),
      });
      expect([400, 500]).toContain(resp.status);
    });

    afterAll(async () => {
      if (origCaptured && origPortalMsg !== undefined) {
        await fetch(url("/dashboard/api/settings"), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ portal_sms_message: origPortalMsg }),
        });
      }
    });
  });

  // ── 35. Send-instructions endpoint ───────────────────────────────────────
  // Validation-only; we don't drive the actual SMS send because that requires
  // a configured `setup_instructions` template + costs Twilio dollars.

  describe("Send instructions — validation paths", () => {
    it("POST without `id` returns 400", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/send-instructions`), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      expect((await json(resp)).error).toMatch(/id/);
    });

    it("POST with id but nonexistent slug returns 404", async () => {
      const resp = await fetch(url("/dashboard/api/agents/nonexistent-xyz/send-instructions"), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ id: "any-template-id" }),
      });
      expect(resp.status).toBe(404);
    });

    it("POST with id pointing at a nonexistent template returns 404", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/send-instructions`), {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ id: "_systest_no_such_template_" + Date.now() }),
      });
      expect(resp.status).toBe(404);
      expect((await json(resp)).error).toMatch(/instruction template/i);
    });
  });

  // ── Lead intake (Apps Script bearer-token endpoint) ─────────────────────
  // Skipped unless LEAD_INTAKE_TOKEN is set in the test env, since these
  // tests can't fake-auth past the timing-safe token check.
  //
  // The happy-path test asserts on `status === 'queued'` only ("Created
  // Only" — the lead's initial state). Background enrichment will flip the
  // status to enriching → ready/failed asynchronously, but we don't wait
  // on it; afterAll dismisses anything we created so the queue stays clean.

  const LEAD_INTAKE_TOKEN = process.env.LEAD_INTAKE_TOKEN;
  const hasIntakeToken = !!LEAD_INTAKE_TOKEN;

  describe.skipIf(!hasIntakeToken)("Lead intake — POST /api/leads/intake", () => {
    const TEST_NAME_PREFIX = "[SYSTEM TEST] ";
    const createdLeadIds: string[] = [];
    let origIntakeEnabled: boolean | undefined;

    beforeAll(async () => {
      const r = await fetch(url("/dashboard/api/settings"), { headers: authHeaders() });
      const s = await json(r);
      origIntakeEnabled = s.lead_intake_enabled;
    });

    afterAll(async () => {
      // Best-effort cleanup: dismiss every lead the test created so they
      // drop out of the active queue, then restore the toggle.
      for (const id of createdLeadIds) {
        try {
          await fetch(url(`/api/leads/${id}/dismiss`), {
            method: "POST", headers: authHeaders(),
          });
        } catch (_) { /* ignore — best effort */ }
      }
      if (origIntakeEnabled !== undefined) {
        await fetch(url("/dashboard/api/settings"), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ lead_intake_enabled: origIntakeEnabled }),
        });
      }
    });

    it("rejects requests with no Authorization header (401)", async () => {
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: TEST_NAME_PREFIX + "no-auth" }),
      });
      expect(resp.status).toBe(401);
    });

    it("rejects requests with the wrong bearer token (401)", async () => {
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer not-the-real-token",
        },
        body: JSON.stringify({ name: TEST_NAME_PREFIX + "wrong-token" }),
      });
      expect(resp.status).toBe(401);
    });

    it("returns 400 when name is missing or whitespace-only", async () => {
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LEAD_INTAKE_TOKEN}`,
        },
        body: JSON.stringify({ phone: "+15551112222" }),
      });
      expect(resp.status).toBe(400);
    });

    it("returns 423 when the dashboard pause toggle is off — and never creates the lead", async () => {
      // Flip the toggle off, post, expect 423, restore.
      await fetch(url("/dashboard/api/settings"), {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ lead_intake_enabled: false }),
      });
      try {
        const resp = await fetch(url("/api/leads/intake"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${LEAD_INTAKE_TOKEN}`,
          },
          body: JSON.stringify({ name: TEST_NAME_PREFIX + "paused-" + Date.now() }),
        });
        expect(resp.status).toBe(423);
        const body = await json(resp);
        expect(body.error).toMatch(/paused/i);
      } finally {
        // Re-enable so the next test can run; afterAll restores the
        // *original* value at the end of the suite.
        await fetch(url("/dashboard/api/settings"), {
          method: "PATCH", headers: authHeaders(),
          body: JSON.stringify({ lead_intake_enabled: true }),
        });
      }
    });

    it("creates a lead with status='queued' on the happy path (Created Only)", async () => {
      const testName = TEST_NAME_PREFIX + "happy-" + Date.now();
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LEAD_INTAKE_TOKEN}`,
        },
        body: JSON.stringify({ name: testName, source: "system_test" }),
      });
      expect(resp.status).toBe(201);
      const body = await json(resp);
      expect(typeof body._id).toBe("string");
      expect(body.status).toBe("queued");
      createdLeadIds.push(body._id);

      // Verify it landed by reading back via the admin-authed list endpoint.
      // Don't wait for enrichment — assert only on the initial Created state.
      const lookup = await fetch(url(`/api/leads/${body._id}`), { headers: authHeaders() });
      expect(lookup.status).toBe(200);
      const lead = await json(lookup);
      expect(lead.input.name).toBe(testName);
      expect(lead.source).toBe("system_test");
    });

    it("creates a lead with externalId on first POST (201)", async () => {
      const externalId = "system-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const testName = TEST_NAME_PREFIX + "extid-fresh-" + Date.now();
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LEAD_INTAKE_TOKEN}`,
        },
        body: JSON.stringify({ name: testName, source: "system_test", externalId }),
      });
      expect(resp.status).toBe(201);
      const body = await json(resp);
      expect(typeof body._id).toBe("string");
      expect(body.deduped).toBeUndefined();
      createdLeadIds.push(body._id);

      const lookup = await fetch(url(`/api/leads/${body._id}`), { headers: authHeaders() });
      const lead = await json(lookup);
      expect(lead.externalId).toBe(externalId);
    });

    it("stores business_type on the lead when intake includes it", async () => {
      const externalId = "system-test-bt-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const testName = TEST_NAME_PREFIX + "biztype-" + Date.now();
      const resp = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LEAD_INTAKE_TOKEN}`,
        },
        body: JSON.stringify({
          name: testName,
          source: "system_test",
          externalId,
          business_type: "HVAC",
        }),
      });
      expect(resp.status).toBe(201);
      const body = await json(resp);
      createdLeadIds.push(body._id);
      const lookup = await fetch(url(`/api/leads/${body._id}`), { headers: authHeaders() });
      const lead = await json(lookup);
      expect(lead.input.business_type).toBe("HVAC");
    });

    it("dedups a duplicate externalId — second POST returns 200 with the same _id", async () => {
      const externalId = "system-test-dup-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const testName = TEST_NAME_PREFIX + "extid-dup-" + Date.now();

      const first = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LEAD_INTAKE_TOKEN}`,
        },
        body: JSON.stringify({ name: testName, source: "system_test", externalId }),
      });
      expect(first.status).toBe(201);
      const firstBody = await json(first);
      createdLeadIds.push(firstBody._id);

      // Second POST with the same externalId but a different name body —
      // should return the existing lead, not create a new one.
      const second = await fetch(url("/api/leads/intake"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LEAD_INTAKE_TOKEN}`,
        },
        body: JSON.stringify({ name: testName + " (resend)", source: "system_test", externalId }),
      });
      expect(second.status).toBe(200);
      const secondBody = await json(second);
      expect(secondBody._id).toBe(firstBody._id);
      expect(secondBody.deduped).toBe(true);
    });
  });
});
