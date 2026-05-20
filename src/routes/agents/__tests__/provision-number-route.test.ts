import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const {
  mockGetClientDocument, mockUpdateClientField,
  mockProvisionPhoneNumber, mockLogPhoneEvent,
} = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
  mockUpdateClientField: vi.fn(),
  mockProvisionPhoneNumber: vi.fn(),
  mockLogPhoneEvent: vi.fn(),
}));

vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
  updateClientField: (...a: any[]) => mockUpdateClientField(...a),
}));
vi.mock("../../../lib/provision-number.js", () => ({
  provisionPhoneNumber: (...a: any[]) => mockProvisionPhoneNumber(...a),
}));
vi.mock("../../../lib/phone-number-history.js", () => ({
  logPhoneEvent: (...a: any[]) => mockLogPhoneEvent(...a),
}));

const { provisionNumberHandler } = await import("../provision-number.js");

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeReq(body: any): Request {
  return { body } as any;
}

beforeEach(() => {
  for (const m of [mockGetClientDocument, mockUpdateClientField, mockProvisionPhoneNumber, mockLogPhoneEvent])
    m.mockReset();
});

describe("provisionNumberHandler", () => {
  it("returns 400 when slug missing", async () => {
    const res = makeRes();
    await provisionNumberHandler(makeReq({}), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when client not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await provisionNumberHandler(makeReq({ slug: "x" }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when client has no agent_id", async () => {
    mockGetClientDocument.mockResolvedValue({ name: "Acme" });
    const res = makeRes();
    await provisionNumberHandler(makeReq({ slug: "acme" }), res);
    expect(res._status).toBe(400);
  });

  it("uses client-level dispatch_call_number for area code derivation", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Acme",
      agent_id: "agent_1",
      dispatch_call_number: "+18159990000",
    });
    mockProvisionPhoneNumber.mockResolvedValue({
      phoneNumber: "+18155551111", phoneNumberSid: "sid1",
    });
    const res = makeRes();
    await provisionNumberHandler(makeReq({ slug: "acme" }), res);
    expect(res._status).toBe(200);
    expect(res._json.phone_number).toBe("+18155551111");
    expect(mockProvisionPhoneNumber.mock.calls[0][0].dispatchCallNumber).toBe("+18159990000");
    expect(mockUpdateClientField).toHaveBeenCalledWith("acme", "outbound_from_number", "+18155551111");
    expect(mockLogPhoneEvent).toHaveBeenCalledWith("acme", "+18155551111", "sid1", "provisioned");
  });

  it("falls back to per-path dispatch override when no client-level number", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Acme",
      agent_id: "agent_1",
      dispatch_call_number: null,
      dispatch_by_type: {
        sales: { dispatch_call_number: "+12125550000" },
      },
    });
    mockProvisionPhoneNumber.mockResolvedValue({
      phoneNumber: "+12125551111", phoneNumberSid: "sid2",
    });
    const res = makeRes();
    await provisionNumberHandler(makeReq({ slug: "acme" }), res);
    expect(res._status).toBe(200);
    expect(mockProvisionPhoneNumber.mock.calls[0][0].dispatchCallNumber).toBe("+12125550000");
  });

  it("forwards an explicit areaCode override to provisionPhoneNumber", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Grit Services",
      agent_id: "agent_grit",
      dispatch_call_number: null,
    });
    mockProvisionPhoneNumber.mockResolvedValue({
      phoneNumber: "+12485550199", phoneNumberSid: "sidGrit",
    });
    const res = makeRes();
    await provisionNumberHandler(makeReq({ slug: "grit-services", areaCode: 248 }), res);
    expect(res._status).toBe(200);
    expect(mockProvisionPhoneNumber.mock.calls[0][0].areaCode).toBe(248);
    expect(mockUpdateClientField).toHaveBeenCalledWith("grit-services", "outbound_from_number", "+12485550199");
  });

  it("returns 400 when areaCode is not a 3-digit number", async () => {
    const res = makeRes();
    await provisionNumberHandler(makeReq({ slug: "x", areaCode: 99 }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/areaCode/);
    // Ensure we short-circuited before touching Mongo / Twilio
    expect(mockGetClientDocument).not.toHaveBeenCalled();
    expect(mockProvisionPhoneNumber).not.toHaveBeenCalled();
  });

  it("returns 502 when provisioning throws", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1", name: "A" });
    mockProvisionPhoneNumber.mockRejectedValue(new Error("twilio rejected"));
    const res = makeRes();
    await provisionNumberHandler(makeReq({ slug: "acme" }), res);
    expect(res._status).toBe(502);
    expect(res._json.details).toBe("twilio rejected");
  });
});
