import { describe, it, expect, vi, beforeEach } from "vitest";
// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("../../../config.js", () => ({
    config: { RETELL_SIGNATURE_KEY: "test-sig-key" },
}));
const { mockVerify } = vi.hoisted(() => ({
    mockVerify: vi.fn().mockReturnValue(true),
}));
vi.mock("../../../lib/verify-retell.js", () => ({
    verifyRetellWebhookOr401: mockVerify,
}));
const { mockAgentIdToClient, mockAgentIdToSlug, mockPhoneNumberToClient } = vi.hoisted(() => ({
    mockAgentIdToClient: {},
    mockAgentIdToSlug: {},
    mockPhoneNumberToClient: {},
}));
vi.mock("../../../_cache/clients.js", () => ({
    agentIdToClient: mockAgentIdToClient,
    agentIdToSlug: mockAgentIdToSlug,
    phoneNumberToClient: mockPhoneNumberToClient,
}));
import { preHookHandler } from "../pre-hook.js";
// ── Helpers ────────────────────────────────────────────────────────────────
function mockReq(body) {
    return {
        headers: { "x-retell-signature": "valid-sig" },
        rawBody: JSON.stringify(body),
        body,
    };
}
function mockRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
function makeClient(overrides = {}) {
    return {
        name: "Test Co",
        agent_id: "agent_abc",
        dispatch_text_numbers: ["+15551234567"],
        active: undefined,
        ...overrides,
    };
}
// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockReturnValue(true);
    for (const k of Object.keys(mockAgentIdToClient))
        delete mockAgentIdToClient[k];
    for (const k of Object.keys(mockAgentIdToSlug))
        delete mockAgentIdToSlug[k];
    for (const k of Object.keys(mockPhoneNumberToClient))
        delete mockPhoneNumberToClient[k];
});
describe("preHookHandler", () => {
    it("returns early when signature verification fails", async () => {
        mockVerify.mockReturnValue(false);
        const res = mockRes();
        await preHookHandler(mockReq({}), res);
        expect(res._json).toBeNull();
    });
    it("ignores non-inbound events", async () => {
        const res = mockRes();
        await preHookHandler(mockReq({ event: "call_ended" }), res);
        expect(res._status).toBe(200);
        expect(res._json.outcome).toBe("ignored_event");
        expect(res._json.event).toBe("call_ended");
    });
    it("ignores null event type", async () => {
        const res = mockRes();
        await preHookHandler(mockReq({}), res);
        expect(res._status).toBe(200);
        expect(res._json.outcome).toBe("ignored_event");
    });
    it("resolves client by agent_id and passes through", async () => {
        const client = makeClient();
        mockAgentIdToClient["agent_abc"] = client;
        mockAgentIdToSlug["agent_abc"] = "test-co";
        const res = mockRes();
        await preHookHandler(mockReq({
            event: "call_inbound",
            call_inbound: { agent_id: "agent_abc", to_number: "+15559999999" },
        }), res);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ call_inbound: {} });
    });
    it("resolves client by to_number when agent_id is absent", async () => {
        const client = makeClient();
        mockPhoneNumberToClient["+15559999999"] = { slug: "test-co", config: client };
        const res = mockRes();
        await preHookHandler(mockReq({
            event: "call_inbound",
            call_inbound: { to_number: "+15559999999" },
        }), res);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ call_inbound: {} });
    });
    it("passes through for unknown agent/number", async () => {
        const res = mockRes();
        await preHookHandler(mockReq({
            event: "call_inbound",
            call_inbound: { agent_id: "agent_unknown", to_number: "+10000000000" },
        }), res);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ call_inbound: {} });
    });
    it("handles chat_inbound events", async () => {
        const client = makeClient();
        mockAgentIdToClient["agent_abc"] = client;
        mockAgentIdToSlug["agent_abc"] = "test-co";
        const res = mockRes();
        await preHookHandler(mockReq({
            event: "chat_inbound",
            chat_inbound: { agent_id: "agent_abc", to_number: "+15559999999" },
        }), res);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ chat_inbound: {} });
    });
    it("agent_id takes precedence over to_number", async () => {
        const clientA = makeClient({ name: "Client A" });
        const clientB = makeClient({ name: "Client B" });
        mockAgentIdToClient["agent_abc"] = clientA;
        mockAgentIdToSlug["agent_abc"] = "client-a";
        mockPhoneNumberToClient["+15559999999"] = { slug: "client-b", config: clientB };
        const spy = vi.spyOn(console, "log").mockImplementation(() => { });
        const res = mockRes();
        await preHookHandler(mockReq({
            event: "call_inbound",
            call_inbound: { agent_id: "agent_abc", to_number: "+15559999999" },
        }), res);
        const validatedLog = spy.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("inbound call validated"));
        expect(validatedLog[1]).toMatchObject({ client: "client-a" });
        spy.mockRestore();
    });
    it("active: undefined is treated as active (logs true)", async () => {
        const client = makeClient(); // active is undefined
        mockAgentIdToClient["agent_abc"] = client;
        mockAgentIdToSlug["agent_abc"] = "test-co";
        const spy = vi.spyOn(console, "log").mockImplementation(() => { });
        const res = mockRes();
        await preHookHandler(mockReq({
            event: "call_inbound",
            call_inbound: { agent_id: "agent_abc", to_number: "+15559999999" },
        }), res);
        const validatedLog = spy.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("inbound call validated"));
        expect(validatedLog[1]).toMatchObject({ active: true });
        spy.mockRestore();
    });
    it("logs active status for known clients", async () => {
        const client = makeClient({ active: false });
        mockAgentIdToClient["agent_abc"] = client;
        mockAgentIdToSlug["agent_abc"] = "test-co";
        const spy = vi.spyOn(console, "log").mockImplementation(() => { });
        const res = mockRes();
        await preHookHandler(mockReq({
            event: "call_inbound",
            call_inbound: { agent_id: "agent_abc", to_number: "+15559999999" },
        }), res);
        const validatedLog = spy.mock.calls.find((c) => typeof c[0] === "string" && c[0].includes("inbound call validated"));
        expect(validatedLog).toBeTruthy();
        expect(validatedLog[1]).toMatchObject({ active: false });
        spy.mockRestore();
    });
});
