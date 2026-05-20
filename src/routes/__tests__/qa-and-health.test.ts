import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const {
  mockGetClientDocument, mockRunSmokeTest, mockBuildSyntheticVariables,
} = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
  mockRunSmokeTest: vi.fn(),
  mockBuildSyntheticVariables: vi.fn(),
}));

vi.mock("../../config.js", () => ({ config: { RETELL_API_KEY: "k", API_KEY: "internal" } }));
vi.mock("retell-sdk", () => ({ default: class { agent = { retrieve: vi.fn() }; } }));
vi.mock("../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
}));
vi.mock("../../lib/qa-smoke.js", () => ({
  runSmokeTest: (...a: any[]) => mockRunSmokeTest(...a),
  buildSyntheticVariables: (...a: any[]) => mockBuildSyntheticVariables(...a),
}));

const { mockMongoPing } = vi.hoisted(() => ({ mockMongoPing: vi.fn() }));
vi.mock("../../lib/db.js", () => ({
  getDb: () => ({ command: (...a: any[]) => mockMongoPing(...a) }),
}));

const { qaRouter } = await import("../qa.js");
const { healthRouter } = await import("../health.js");

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeReq(opts: { params?: any; query?: any; body?: any; host?: string }): Request {
  const headers: Record<string, string> = { host: opts.host ?? "localhost:3000" };
  return {
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    protocol: "https",
    headers,
    get: (h: string) => headers[h.toLowerCase()],
  } as any;
}

function findRoute(router: any, method: string, path: string) {
  for (const layer of router.stack as any[]) {
    if (!layer.route) continue;
    if (layer.route.path === path && layer.route.methods[method]) return layer.route.stack;
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

async function runRoute(router: any, method: string, path: string, req: Request, res: Response) {
  const stack = findRoute(router, method, path);
  for (let i = 0; i < stack.length; i++) {
    let advance = false; let nextErr: any = null;
    const next = (err?: any) => { if (err) nextErr = err; advance = true; };
    const result = stack[i].handle(req, res, next);
    if (result && typeof (result as Promise<unknown>).then === "function") await result;
    if (nextErr) throw nextErr;
    if (!advance) return;
  }
}

beforeEach(() => {
  for (const m of [mockGetClientDocument, mockRunSmokeTest, mockBuildSyntheticVariables]) m.mockReset();
});

// ── healthRouter ──────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns ok with timestamp when mongo ping succeeds", async () => {
    mockMongoPing.mockResolvedValue({ ok: 1 });
    const res = makeRes();
    await runRoute(healthRouter, "get", "/", makeReq({}), res);
    expect(res._json.status).toBe("ok");
    expect(res._json.checks.mongo.ok).toBe(true);
    expect(typeof res._json.timestamp).toBe("string");
  });

  it("returns 503 degraded when mongo ping throws", async () => {
    mockMongoPing.mockRejectedValue(new Error("connection refused"));
    const res = makeRes();
    await runRoute(healthRouter, "get", "/", makeReq({}), res);
    expect(res._status).toBe(503);
    expect(res._json.status).toBe("degraded");
    expect(res._json.checks.mongo.ok).toBe(false);
    expect(res._json.checks.mongo.error).toMatch(/connection/);
  });

  it("returns 503 with a timeout error when the mongo ping hangs past the deadline", async () => {
    vi.useFakeTimers();
    try {
      // Ping never resolves — simulates a driver wedged on an EAI_AGAIN /
      // network blip, the exact scenario that caused the 2026-05-20 outage.
      mockMongoPing.mockReturnValue(new Promise(() => {}));
      const res = makeRes();
      const p = runRoute(healthRouter, "get", "/", makeReq({}), res);
      await vi.advanceTimersByTimeAsync(2_500);
      await p;
      expect(res._status).toBe(503);
      expect(res._json.checks.mongo.ok).toBe(false);
      expect(res._json.checks.mongo.error).toMatch(/timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── qaRouter ──────────────────────────────────────────────────────────────

describe("POST /qa/smoke/:slug", () => {
  it("returns 404 when client not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute(qaRouter, "post", "/smoke/:slug", makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when no agent_id", async () => {
    mockGetClientDocument.mockResolvedValue({ name: "x" });
    const res = makeRes();
    await runRoute(qaRouter, "post", "/smoke/:slug", makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(400);
  });

  it("runs smoke test and returns the report", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1" });
    mockRunSmokeTest.mockResolvedValue({ ok: true, score: 99 });
    const res = makeRes();
    await runRoute(qaRouter, "post", "/smoke/:slug",
      makeReq({ params: { slug: "x" }, query: { notify: "true" }, host: "app.example.com" }), res);
    expect(res._json).toEqual({ ok: true, score: 99 });
    const opts = mockRunSmokeTest.mock.calls[0][2];
    expect(opts.notify).toBe(true);
    expect(opts.postHookUrl).toBe("https://app.example.com/retell/post-hook");
  });

  it("returns 500 when smoke test throws", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1" });
    mockRunSmokeTest.mockRejectedValue(new Error("smoke failed"));
    const res = makeRes();
    await runRoute(qaRouter, "post", "/smoke/:slug", makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(500);
  });
});

describe("POST /qa/test-notify/:slug", () => {
  it("returns 404 when client not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute(qaRouter, "post", "/test-notify/:slug", makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when no agent_id", async () => {
    mockGetClientDocument.mockResolvedValue({ name: "x" });
    const res = makeRes();
    await runRoute(qaRouter, "post", "/test-notify/:slug", makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(400);
  });

  it("posts synthetic call to post-hook and returns success on 2xx", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1", shadow_mode: false });
    mockBuildSyntheticVariables.mockReturnValue({ full_name: "Test User" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ outcome: "dispatched" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = makeRes();
    await runRoute(qaRouter, "post", "/test-notify/:slug",
      makeReq({ params: { slug: "x" }, host: "app.example.com" }), res);
    expect(res._json).toMatchObject({ success: true, outcome: "dispatched", shadow_mode: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://app.example.com/retell/post-hook",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });

  it("propagates failure status from post-hook", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1" });
    mockBuildSyntheticVariables.mockReturnValue({});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 502,
      json: async () => ({ message: "downstream failed" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = makeRes();
    await runRoute(qaRouter, "post", "/test-notify/:slug",
      makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(502);
    expect(res._json).toEqual({ success: false, error: "downstream failed" });
    vi.unstubAllGlobals();
  });

  it("returns 500 when fetch throws", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1" });
    mockBuildSyntheticVariables.mockReturnValue({});
    const fetchMock = vi.fn().mockRejectedValue(new Error("net down"));
    vi.stubGlobal("fetch", fetchMock);

    const res = makeRes();
    await runRoute(qaRouter, "post", "/test-notify/:slug",
      makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(500);
    vi.unstubAllGlobals();
  });
});
