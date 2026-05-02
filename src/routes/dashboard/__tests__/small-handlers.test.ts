import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const {
  mockGetClientDocument, mockUpdateClientField, mockUpdateClientFields,
  mockGetCallLogsByClient,
} = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
  mockUpdateClientField: vi.fn(),
  mockUpdateClientFields: vi.fn(),
  mockGetCallLogsByClient: vi.fn(),
}));

vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
  updateClientField: (...a: any[]) => mockUpdateClientField(...a),
  updateClientFields: (...a: any[]) => mockUpdateClientFields(...a),
}));
vi.mock("../../../lib/call-log.js", () => ({
  getCallLogsByClient: (...a: any[]) => mockGetCallLogsByClient(...a),
}));

const { getAgentHandler } = await import("../get-agent.js");
const { getCallsHandler } = await import("../get-calls.js");
const { updateAgentHandler } = await import("../update-agent.js");
const { toggleShadowHandler } = await import("../toggle-shadow.js");

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeReq(opts: { params?: any; body?: any; query?: any }): Request {
  return { params: opts.params ?? {}, body: opts.body ?? {}, query: opts.query ?? {} } as any;
}

beforeEach(() => {
  for (const m of [mockGetClientDocument, mockUpdateClientField, mockUpdateClientFields, mockGetCallLogsByClient])
    m.mockReset();
});

describe("getAgentHandler", () => {
  it("returns 404 when slug not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await getAgentHandler(makeReq({ params: { slug: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns the doc on success", async () => {
    mockGetClientDocument.mockResolvedValue({ name: "Acme" });
    const res = makeRes();
    await getAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._json.name).toBe("Acme");
  });

  it("returns 500 on unexpected error", async () => {
    mockGetClientDocument.mockRejectedValue(new Error("db down"));
    const res = makeRes();
    await getAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(500);
  });
});

describe("getCallsHandler", () => {
  it("returns calls with default limit/offset", async () => {
    mockGetCallLogsByClient.mockResolvedValue([{ _id: "1" }]);
    const res = makeRes();
    await getCallsHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._json).toEqual([{ _id: "1" }]);
    expect(mockGetCallLogsByClient).toHaveBeenCalledWith("acme", 50, 0, { includeTests: false });
  });

  it("clamps limit to 100 and parses offset", async () => {
    mockGetCallLogsByClient.mockResolvedValue([]);
    const res = makeRes();
    await getCallsHandler(makeReq({ params: { slug: "acme" }, query: { limit: "999", offset: "20" } }), res);
    expect(mockGetCallLogsByClient).toHaveBeenCalledWith("acme", 100, 20, { includeTests: false });
  });

  it("passes includeTests=true when ?include_tests=1", async () => {
    mockGetCallLogsByClient.mockResolvedValue([]);
    const res = makeRes();
    await getCallsHandler(makeReq({ params: { slug: "acme" }, query: { include_tests: "1" } }), res);
    expect(mockGetCallLogsByClient).toHaveBeenCalledWith("acme", 50, 0, { includeTests: true });
  });

  it("returns 500 on db failure", async () => {
    mockGetCallLogsByClient.mockRejectedValue(new Error("oops"));
    const res = makeRes();
    await getCallsHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(500);
  });
});

describe("updateAgentHandler", () => {
  it("returns 400 when body missing", async () => {
    const res = makeRes();
    await updateAgentHandler(makeReq({ params: { slug: "acme" }, body: null }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when body empty", async () => {
    const res = makeRes();
    await updateAgentHandler(makeReq({ params: { slug: "acme" }, body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("updates and returns the doc", async () => {
    mockUpdateClientFields.mockResolvedValue(undefined);
    mockGetClientDocument.mockResolvedValue({ name: "New" });
    const res = makeRes();
    await updateAgentHandler(makeReq({ params: { slug: "acme" }, body: { name: "New" } }), res);
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.doc.name).toBe("New");
  });

  it("returns 404 when error message contains 'not found'", async () => {
    mockUpdateClientFields.mockRejectedValue(new Error("Client \"x\" not found"));
    const res = makeRes();
    await updateAgentHandler(makeReq({ params: { slug: "x" }, body: { name: "X" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 on generic validation errors", async () => {
    mockUpdateClientFields.mockRejectedValue(new Error("invalid field"));
    const res = makeRes();
    await updateAgentHandler(makeReq({ params: { slug: "x" }, body: { name: "X" } }), res);
    expect(res._status).toBe(400);
  });
});

describe("toggleShadowHandler", () => {
  it("returns 400 when shadow_mode not boolean", async () => {
    const res = makeRes();
    await toggleShadowHandler(makeReq({ params: { slug: "acme" }, body: { shadow_mode: "yes" } }), res);
    expect(res._status).toBe(400);
  });

  it("toggles successfully", async () => {
    mockUpdateClientField.mockResolvedValue(undefined);
    const res = makeRes();
    await toggleShadowHandler(makeReq({ params: { slug: "acme" }, body: { shadow_mode: false } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, slug: "acme", shadow_mode: false });
    expect(mockUpdateClientField).toHaveBeenCalledWith("acme", "shadow_mode", false);
  });

  it("returns 404 when update throws", async () => {
    mockUpdateClientField.mockRejectedValue(new Error("not found"));
    const res = makeRes();
    await toggleShadowHandler(makeReq({ params: { slug: "x" }, body: { shadow_mode: true } }), res);
    expect(res._status).toBe(404);
  });
});
