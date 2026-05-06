import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockGetClientDocument, mockUpdateClientField, mockProvisionPhoneNumber, mockLogPhoneEvent, } = vi.hoisted(() => ({
    mockGetClientDocument: vi.fn(),
    mockUpdateClientField: vi.fn(),
    mockProvisionPhoneNumber: vi.fn(),
    mockLogPhoneEvent: vi.fn(),
}));
vi.mock("../../../config/client-store.js", () => ({
    getClientDocument: (...a) => mockGetClientDocument(...a),
    updateClientField: (...a) => mockUpdateClientField(...a),
}));
vi.mock("../../../lib/provision-number.js", () => ({
    provisionPhoneNumber: (...a) => mockProvisionPhoneNumber(...a),
}));
vi.mock("../../../lib/phone-number-history.js", () => ({
    logPhoneEvent: (...a) => mockLogPhoneEvent(...a),
}));
const { provisionNumberHandler } = await import("../provision-number.js");
function makeRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
function makeReq(body) {
    return { body };
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
    it("returns 502 when provisioning throws", async () => {
        mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1", name: "A" });
        mockProvisionPhoneNumber.mockRejectedValue(new Error("twilio rejected"));
        const res = makeRes();
        await provisionNumberHandler(makeReq({ slug: "acme" }), res);
        expect(res._status).toBe(502);
        expect(res._json.details).toBe("twilio rejected");
    });
});
