import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SYSTEM_TEST_URL ?? process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const ROOT_PASSWORD = process.env.ROOT_PASSWORD;

const hasConfig = !!BASE_URL && BASE_URL.startsWith("http") && !!API_KEY && !!ROOT_PASSWORD;

const SLUG_A = "demo-hvac2";

function url(path: string): string {
  return `${BASE_URL}${path}`;
}

// Rate-limit-resilient fetch — see system.test.ts for rationale. Shadows
// the global fetch: retries on 429 with a capped backoff.
const _realFetch = globalThis.fetch;
async function fetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const resp = await _realFetch(input, init);
    if (resp.status !== 429 || attempt === 5) return resp;
    const headerSec = Number(resp.headers.get("retry-after"));
    // Honor the server's Retry-After (capped 60s); else short backoff.
    const waitSec =
      Number.isFinite(headerSec) && headerSec > 0
        ? Math.min(headerSec, 60)
        : Math.min(attempt * 2, 10);
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
  return _realFetch(input, init);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": API_KEY!,
    Authorization: "Basic " + Buffer.from(`sam_admin:${ROOT_PASSWORD}`).toString("base64"),
    "Content-Type": "application/json",
    ...extra,
  };
}

async function json(resp: Response): Promise<any> {
  return resp.json();
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// The portal flow is the only customer-facing read path for client config and
// call history. A token issued for client A must NEVER read or mutate client
// B's data — the entire multi-tenant boundary depends on it. Unit tests cover
// validatePortalToken(); this file proves the binding is enforced over the
// wire on every portal endpoint.

describe.skipIf(!hasConfig)("System tests — Multi-tenant isolation", { timeout: 30_000 }, () => {
  let slugB: string;
  let tokenA: string;

  beforeAll(async () => {
    // Pick a second slug from the agents list — any agent that isn't SLUG_A.
    const listResp = await fetch(url("/dashboard/api/agents"), { headers: authHeaders() });
    if (!listResp.ok) throw new Error(`Failed to list agents: ${listResp.status}`);
    const agents = (await json(listResp)) as Array<{ slug?: string; _id?: string }>;
    const other = agents.find((a) => {
      const s = a.slug ?? a._id;
      return s && s !== SLUG_A;
    });
    if (!other) throw new Error("Need at least 2 agents for cross-tenant tests; found < 2");
    slugB = (other.slug ?? other._id) as string;

    // Reuse the existing portal token for slug A if one is set; only mint a
    // new one when there isn't. Minting rotates the live token and would
    // invalidate any magic links already in customer inboxes.
    const getResp = await fetch(url(`/dashboard/api/agents/${SLUG_A}/portal-token`), {
      headers: authHeaders(),
    });
    if (getResp.ok) {
      const getBody = await json(getResp);
      tokenA = String(getBody.portal_url ?? "").match(/[?&]token=([^&]+)/)?.[1] ?? "";
    }
    if (!tokenA) {
      const tokResp = await fetch(url(`/dashboard/api/agents/${SLUG_A}/portal-token`), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!tokResp.ok) {
        throw new Error(`Failed to generate portal token for ${SLUG_A}: ${tokResp.status}`);
      }
      const tokBody = await json(tokResp);
      tokenA = String(tokBody.portal_url ?? "").match(/[?&]token=([^&]+)/)?.[1] ?? "";
      if (!tokenA) throw new Error("Could not extract portal token from response: " + JSON.stringify(tokBody));
    }
  });

  describe("Bearer header path", () => {
    it("token A cannot GET /portal/{B}/api/agent", async () => {
      const resp = await fetch(url(`/portal/${slugB}/api/agent`), {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(resp.status).toBe(401);
    });

    it("token A cannot GET /portal/{B}/api/calls", async () => {
      const resp = await fetch(url(`/portal/${slugB}/api/calls`), {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(resp.status).toBe(401);
    });

    it("token A cannot PATCH /portal/{B}/api/settings", async () => {
      const resp = await fetch(url(`/portal/${slugB}/api/settings`), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ dispatch_email: ["evil@example.com"] }),
      });
      expect(resp.status).toBe(401);
    });
  });

  describe("Query-string token path (legacy magic link)", () => {
    it("token A in ?token= cannot GET /portal/{B}/api/agent", async () => {
      const resp = await fetch(url(`/portal/${slugB}/api/agent?token=${encodeURIComponent(tokenA)}`));
      expect(resp.status).toBe(401);
    });

    it("token A in ?token= cannot GET /portal/{B}/api/calls", async () => {
      const resp = await fetch(url(`/portal/${slugB}/api/calls?token=${encodeURIComponent(tokenA)}`));
      expect(resp.status).toBe(401);
    });
  });

  describe("Sanity — token A still works for slug A", () => {
    it("token A can GET /portal/{A}/api/agent (proves the token itself is live)", async () => {
      const resp = await fetch(url(`/portal/${SLUG_A}/api/agent`), {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(resp.status).toBe(200);
    });
  });
});
