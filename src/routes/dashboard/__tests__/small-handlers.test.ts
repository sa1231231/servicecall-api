import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const {
  mockGetClientDocument, mockUpdateClientField, mockUpdateClientFields,
  mockGetCallLogsByClient, mockSyncRetellDisplayLabels,
} = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
  mockUpdateClientField: vi.fn(),
  mockUpdateClientFields: vi.fn(),
  mockGetCallLogsByClient: vi.fn(),
  mockSyncRetellDisplayLabels: vi.fn(),
}));

vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
  updateClientField: (...a: any[]) => mockUpdateClientField(...a),
  updateClientFields: (...a: any[]) => mockUpdateClientFields(...a),
}));
vi.mock("../../../lib/call-log.js", () => ({
  getCallLogsByClient: (...a: any[]) => mockGetCallLogsByClient(...a),
}));
vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key" } }));
vi.mock("retell-sdk", () => ({ default: class { constructor(_opts: any) {} } }));
vi.mock("../../../lib/retell-display-sync.js", () => ({
  syncRetellDisplayLabels: (...a: any[]) => mockSyncRetellDisplayLabels(...a),
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
  for (const m of [
    mockGetClientDocument, mockUpdateClientField, mockUpdateClientFields,
    mockGetCallLogsByClient, mockSyncRetellDisplayLabels,
  ]) m.mockReset();
  mockSyncRetellDisplayLabels.mockResolvedValue({
    agentNameUpdated: true, nicknameUpdated: [], nicknameErrors: [],
  });
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

  it("does not call Retell sync when display_name is not in the body", async () => {
    mockUpdateClientFields.mockResolvedValue(undefined);
    mockGetClientDocument.mockResolvedValue({ name: "Acme", agent_id: "agent_1" });
    const res = makeRes();
    await updateAgentHandler(
      makeReq({ params: { slug: "acme" }, body: { shadow_mode: true } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(mockSyncRetellDisplayLabels).not.toHaveBeenCalled();
  });

  it("pushes display_name to Retell when set, using the new label", async () => {
    mockUpdateClientFields.mockResolvedValue(undefined);
    mockGetClientDocument.mockResolvedValue({
      name: "Acme Plumbing",
      display_name: "Acme HVAC (demo)",
      agent_id: "agent_1",
      outbound_from_number: "+15550000000",
    });
    const res = makeRes();
    await updateAgentHandler(
      makeReq({ params: { slug: "acme" }, body: { display_name: "Acme HVAC (demo)" } }),
      res,
    );
    expect(res._status).toBe(200);
    expect(mockSyncRetellDisplayLabels).toHaveBeenCalledTimes(1);
    // Signature: (retell, slug, agentId, outboundFromNumber, label)
    const args = mockSyncRetellDisplayLabels.mock.calls[0];
    expect(args[1]).toBe("acme");
    expect(args[2]).toBe("agent_1");
    expect(args[3]).toBe("+15550000000");
    expect(args[4]).toBe("Acme HVAC (demo)");
  });

  it("falls back to business name when display_name is cleared", async () => {
    mockUpdateClientFields.mockResolvedValue(undefined);
    // After the update, the doc has display_name=null — sync should use `name`.
    mockGetClientDocument.mockResolvedValue({
      name: "Acme Plumbing",
      display_name: null,
      agent_id: "agent_1",
      outbound_from_number: null,
    });
    const res = makeRes();
    await updateAgentHandler(
      makeReq({ params: { slug: "acme" }, body: { display_name: "   " } }),
      res,
    );
    expect(res._status).toBe(200);
    // Signature: (retell, slug, agentId, outboundFromNumber, label)
    const args = mockSyncRetellDisplayLabels.mock.calls[0];
    expect(args[4]).toBe("Acme Plumbing");
  });

  it("returns 502 when Retell sync fails after the Mongo write", async () => {
    mockUpdateClientFields.mockResolvedValue(undefined);
    mockGetClientDocument.mockResolvedValue({
      name: "Acme",
      display_name: "Acme (demo)",
      agent_id: "agent_1",
    });
    mockSyncRetellDisplayLabels.mockRejectedValue(new Error("retell down"));
    const res = makeRes();
    await updateAgentHandler(
      makeReq({ params: { slug: "acme" }, body: { display_name: "Acme (demo)" } }),
      res,
    );
    expect(res._status).toBe(502);
    expect(res._json.error).toMatch(/retell down/);
  });

  it("rejects non-string non-null display_name with 400", async () => {
    const res = makeRes();
    await updateAgentHandler(
      makeReq({ params: { slug: "acme" }, body: { display_name: 42 } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(mockUpdateClientFields).not.toHaveBeenCalled();
  });

  // ── contact_* fields (admin-only Client Contact info on the Billing tab) ──
  // The handler trims strings, converts blanks to null, and rejects values
  // that aren't string/null. Same pattern as display_name above.
  describe("contact_* field normalization", () => {
    it("trims whitespace-only contact_name to null", async () => {
      mockUpdateClientFields.mockResolvedValue(undefined);
      mockGetClientDocument.mockResolvedValue({ name: "Acme" });
      const res = makeRes();
      await updateAgentHandler(
        makeReq({ params: { slug: "acme" }, body: { contact_name: "   " } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(mockUpdateClientFields).toHaveBeenCalledWith("acme", { contact_name: null });
    });

    it("trims surrounding whitespace on contact_email and saves", async () => {
      mockUpdateClientFields.mockResolvedValue(undefined);
      mockGetClientDocument.mockResolvedValue({ name: "Acme" });
      const res = makeRes();
      await updateAgentHandler(
        makeReq({ params: { slug: "acme" }, body: { contact_email: "  ops@x.com  " } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(mockUpdateClientFields).toHaveBeenCalledWith("acme", { contact_email: "ops@x.com" });
    });

    it("rejects non-string non-null contact_phone with 400", async () => {
      const res = makeRes();
      await updateAgentHandler(
        makeReq({ params: { slug: "acme" }, body: { contact_phone: 5551234567 } }),
        res,
      );
      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/contact_phone/);
      expect(mockUpdateClientFields).not.toHaveBeenCalled();
    });

    it("passes contact_timezone through unchanged when valid", async () => {
      mockUpdateClientFields.mockResolvedValue(undefined);
      mockGetClientDocument.mockResolvedValue({ name: "Acme" });
      const res = makeRes();
      await updateAgentHandler(
        makeReq({ params: { slug: "acme" }, body: { contact_timezone: "America/Chicago" } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(mockUpdateClientFields).toHaveBeenCalledWith("acme", { contact_timezone: "America/Chicago" });
    });

    it("converts empty-string contact_notes to null", async () => {
      mockUpdateClientFields.mockResolvedValue(undefined);
      mockGetClientDocument.mockResolvedValue({ name: "Acme" });
      const res = makeRes();
      await updateAgentHandler(
        makeReq({ params: { slug: "acme" }, body: { contact_notes: "" } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(mockUpdateClientFields).toHaveBeenCalledWith("acme", { contact_notes: null });
    });

    it("accepts explicit null on any contact_* field", async () => {
      mockUpdateClientFields.mockResolvedValue(undefined);
      mockGetClientDocument.mockResolvedValue({ name: "Acme" });
      const res = makeRes();
      await updateAgentHandler(
        makeReq({ params: { slug: "acme" }, body: { contact_name: null } }),
        res,
      );
      expect(res._status).toBe(200);
      expect(mockUpdateClientFields).toHaveBeenCalledWith("acme", { contact_name: null });
    });
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
