import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ROOT_PASSWORD = process.env.ROOT_PASSWORD;

const hasConfig = !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY && !!ROOT_PASSWORD;

const SLUG = "demo-hvac";

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

function rootBasic(): string {
  return "Basic " + Buffer.from(`sam_admin:${ROOT_PASSWORD}`).toString("base64");
}

function userBasic(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": API_KEY!,
    Authorization: rootBasic(),
    "Content-Type": "application/json",
    ...extra,
  };
}

function viewerHeaders(username: string, password: string): Record<string, string> {
  // Dashboard routes use sessionAuth (Basic) only — no x-api-key needed.
  return {
    Authorization: userBasic(username, password),
    "Content-Type": "application/json",
  };
}

async function json(resp: Response): Promise<any> {
  return resp.json();
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// Unit tests verify requireFeature() in isolation. These tests verify that
// the gate is actually wired into the production middleware stack — that a
// real Basic-auth login as a viewer-role user gets rejected with 403 (not
// 401) on write endpoints, and 200 on read endpoints. Catches regressions
// where a route silently drops the gate or mounts before the auth middleware.

describe.skipIf(!hasConfig)("System tests — Permission gates over the wire", { timeout: 30_000 }, () => {
  const username = "_systest_viewer_" + Date.now();
  const password = "viewerpass-" + Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    const resp = await fetch(url("/dashboard/api/users"), {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ username, password, role: "viewer" }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to create viewer user: ${resp.status} ${await resp.text()}`);
    }
  });

  afterAll(async () => {
    await fetch(url(`/dashboard/api/users/${username}`), {
      method: "DELETE",
      headers: adminHeaders(),
    });
  });

  describe("Read endpoints — viewer can access", () => {
    it("GET /dashboard/api/agents returns 200", async () => {
      const resp = await fetch(url("/dashboard/api/agents"), {
        headers: viewerHeaders(username, password),
      });
      expect(resp.status).toBe(200);
    });

    it("GET /dashboard/api/agents/:slug returns 200", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        headers: viewerHeaders(username, password),
      });
      expect(resp.status).toBe(200);
    });

    it("GET /api/leads returns 200 (viewer has pending_leads:read)", async () => {
      const resp = await fetch(url("/api/leads"), {
        headers: viewerHeaders(username, password),
      });
      expect(resp.status).toBe(200);
    });
  });

  describe("Write endpoints — viewer is blocked with 403, not 401", () => {
    it("PATCH /dashboard/api/agents/:slug/active is rejected", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/active`), {
        method: "PATCH",
        headers: viewerHeaders(username, password),
        body: JSON.stringify({ active: true }),
      });
      // 403 = authenticated but lacks permission.
      // 401 here would indicate the auth itself is broken.
      expect(resp.status).toBe(403);
    });

    it("PATCH /dashboard/api/agents/:slug/shadow is rejected", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/shadow`), {
        method: "PATCH",
        headers: viewerHeaders(username, password),
        body: JSON.stringify({ shadow_mode: true }),
      });
      expect(resp.status).toBe(403);
    });

    it("DELETE /dashboard/api/agents/:slug is rejected", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}`), {
        method: "DELETE",
        headers: viewerHeaders(username, password),
      });
      expect(resp.status).toBe(403);
    });

    it("POST /dashboard/api/agents/:slug/portal-token is rejected", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/portal-token`), {
        method: "POST",
        headers: viewerHeaders(username, password),
      });
      expect(resp.status).toBe(403);
    });

    it("POST /api/leads (manual intake — pending_leads:write) is rejected", async () => {
      const resp = await fetch(url("/api/leads"), {
        method: "POST",
        headers: viewerHeaders(username, password),
        body: JSON.stringify({ name: "[SYSTEM TEST] viewer-blocked" }),
      });
      expect(resp.status).toBe(403);
    });

    it("POST /dashboard/api/users (create user) is rejected", async () => {
      const resp = await fetch(url("/dashboard/api/users"), {
        method: "POST",
        headers: viewerHeaders(username, password),
        body: JSON.stringify({ username: "would-not-be-created", password: "x", role: "viewer" }),
      });
      expect(resp.status).toBe(403);
    });
  });

  describe("Auth failures distinct from permission failures", () => {
    it("missing Authorization → 401, not 403", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/active`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true }),
      });
      expect(resp.status).toBe(401);
    });

    it("wrong password → 401", async () => {
      const resp = await fetch(url(`/dashboard/api/agents/${SLUG}/active`), {
        method: "PATCH",
        headers: viewerHeaders(username, "definitely-wrong"),
        body: JSON.stringify({ active: true }),
      });
      // 401 OR 429 (lockout) are both valid — we only assert it's NOT 200/403.
      expect([401, 429]).toContain(resp.status);
    });
  });
});
