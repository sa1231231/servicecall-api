import { describe, it, expect, vi, beforeEach } from "vitest";
// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock("../../../config.js", () => ({
    config: {
        RETELL_SIGNATURE_KEY: "sig-key",
        API_KEY: "internal-api-key",
    },
}));
const { mockVerify, mockSendSms, mockSendSmsToAll, mockSendEmail, mockGetEmailStatus, mockSendOwnerCallMonitor, mockTriggerDispatchCall, mockSaveCallLog, mockCheckAgentAlerts, mockAgentIdToClient, mockAgentIdToSlug } = vi.hoisted(() => ({
    mockVerify: vi.fn(),
    mockSendSms: vi.fn(),
    mockSendSmsToAll: vi.fn(),
    mockSendEmail: vi.fn(),
    mockGetEmailStatus: vi.fn(),
    mockSendOwnerCallMonitor: vi.fn(),
    mockTriggerDispatchCall: vi.fn(),
    mockSaveCallLog: vi.fn(),
    mockCheckAgentAlerts: vi.fn(),
    mockAgentIdToClient: {},
    mockAgentIdToSlug: {},
}));
vi.mock("../../../lib/verify-retell.js", () => ({
    verifyRetellWebhookOr401: (...a) => mockVerify(...a),
}));
vi.mock("../../../lib/notify-sms.js", () => ({
    sendSms: (...a) => mockSendSms(...a),
    sendSmsToAll: (...a) => mockSendSmsToAll(...a),
}));
vi.mock("../../../lib/notify-email.js", () => ({
    sendEmail: (...a) => mockSendEmail(...a),
    getEmailStatus: (...a) => mockGetEmailStatus(...a),
}));
vi.mock("../../../lib/owner-monitor.js", () => ({
    sendOwnerCallMonitor: (...a) => mockSendOwnerCallMonitor(...a),
}));
vi.mock("../../../lib/dispatch-call.js", () => ({
    triggerDispatchCall: (...a) => mockTriggerDispatchCall(...a),
}));
vi.mock("../../../lib/call-log.js", () => ({
    saveCallLog: (...a) => mockSaveCallLog(...a),
}));
vi.mock("../../../lib/agent-alerts.js", () => ({
    checkAgentAlerts: (...a) => mockCheckAgentAlerts(...a),
}));
vi.mock("../../../_cache/clients.js", () => ({
    agentIdToClient: mockAgentIdToClient,
    agentIdToSlug: mockAgentIdToSlug,
}));
const { postHookHandler } = await import("../post-hook.js");
// ── Helpers ────────────────────────────────────────────────────────────────
function makeReq(body, headers = {}) {
    return {
        headers: { "x-retell-signature": "sig", ...headers },
        rawBody: JSON.stringify(body),
        body,
    };
}
function makeRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
function makeClient(overrides = {}) {
    return {
        name: "Acme",
        agent_ids: ["agent_1"],
        dispatch_text_numbers: ["+15550001111"],
        dispatch_email: ["acme@x.com"],
        dispatch_cc: null,
        dispatch_call_number: null,
        summary_agent_id: null,
        shadow_mode: false,
        resolve_type: () => "default",
        message_types: {
            default: {
                label: "New Lead",
                subject_template: "New lead from {{full_name}}",
                fields: [
                    { key: "full_name", label: "Name" },
                    { key: "phone_number", label: "Phone" },
                ],
            },
        },
        default_message_type: "default",
        ...overrides,
    };
}
function makeBody(overrides = {}) {
    const { call: callOverride, ...rest } = overrides;
    return {
        event: "call_ended",
        call: {
            call_id: "call_x1",
            agent_id: "agent_1",
            from_number: "+15559990000",
            to_number: "+15550001111",
            duration_ms: 30000,
            disconnection_reason: "user_hangup",
            collected_dynamic_variables: {
                full_name: "John Smith",
                phone_number: "+15559990000",
            },
            retell_llm_dynamic_variables: {},
            ...callOverride,
        },
        ...rest,
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockReturnValue(true);
    mockCheckAgentAlerts.mockReturnValue({
        callSurge: { fired: false, count: 0 },
        costSurge: { fired: false, totalCents: 0 },
    });
    mockSendSms.mockResolvedValue({ sid: "SM_1" });
    mockSendSmsToAll.mockResolvedValue([]);
    mockSendEmail.mockResolvedValue({ id: "rs_1" });
    mockSendOwnerCallMonitor.mockResolvedValue(undefined);
    mockTriggerDispatchCall.mockResolvedValue(undefined);
    mockSaveCallLog.mockResolvedValue(undefined);
    for (const k of Object.keys(mockAgentIdToClient))
        delete mockAgentIdToClient[k];
    for (const k of Object.keys(mockAgentIdToSlug))
        delete mockAgentIdToSlug[k];
});
// ── Tests ──────────────────────────────────────────────────────────────────
describe("postHookHandler — signature verification", () => {
    it("returns early when signature verification fails", async () => {
        mockVerify.mockReturnValue(false);
        const res = makeRes();
        await postHookHandler(makeReq(makeBody()), res);
        expect(mockSendSmsToAll).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
    it("skips signature verification for test clients", async () => {
        mockAgentIdToClient["agent_test"] = makeClient({ name: "Test Client" });
        mockAgentIdToSlug["agent_test"] = "test-client";
        const res = makeRes();
        await postHookHandler(makeReq(makeBody({ call: { agent_id: "agent_test", from_number: null } })), res);
        expect(mockVerify).not.toHaveBeenCalled();
    });
    it("skips signature verification when x-api-key matches internal key", async () => {
        mockAgentIdToClient["agent_1"] = makeClient();
        mockAgentIdToSlug["agent_1"] = "acme";
        const res = makeRes();
        await postHookHandler(makeReq(makeBody(), { "x-api-key": "internal-api-key" }), res);
        expect(mockVerify).not.toHaveBeenCalled();
    });
});
describe("postHookHandler — event filtering", () => {
    it("ignores non-call_ended events", async () => {
        const res = makeRes();
        await postHookHandler(makeReq({ event: "call_started" }), res);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ success: true, outcome: "ignored_event", event: "call_started" });
        expect(mockSendSmsToAll).not.toHaveBeenCalled();
    });
    it("400s when call object is missing", async () => {
        const res = makeRes();
        await postHookHandler(makeReq({ event: "call_ended" }), res);
        expect(res._status).toBe(400);
        expect(res._json.success).toBe(false);
    });
});
describe("postHookHandler — client lookup", () => {
    it("returns 200 with no notifications when agent has no client config", async () => {
        const res = makeRes();
        await postHookHandler(makeReq(makeBody()), res);
        expect(res._status).toBe(200);
        expect(mockSendSmsToAll).not.toHaveBeenCalled();
    });
});
describe("postHookHandler — web calls", () => {
    it("logs a web_call outcome and skips dispatch when from_number is missing", async () => {
        mockAgentIdToClient["agent_1"] = makeClient();
        mockAgentIdToSlug["agent_1"] = "acme";
        const res = makeRes();
        const body = makeBody({ call: { from_number: null } });
        await postHookHandler(makeReq(body), res);
        expect(res._json.outcome).toBe("web_call");
        expect(mockSendSmsToAll).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockSaveCallLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "web_call", from_number: "Web Call" }));
    });
});
describe("postHookHandler — dispatch happy path", () => {
    it("sends SMS + email and logs dispatched outcome", async () => {
        mockAgentIdToClient["agent_1"] = makeClient();
        mockAgentIdToSlug["agent_1"] = "acme";
        const res = makeRes();
        await postHookHandler(makeReq(makeBody()), res);
        expect(mockSendSmsToAll).toHaveBeenCalledWith(["+15550001111"], expect.any(String));
        expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "acme@x.com" }));
        expect(mockSaveCallLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "dispatched", message_type_key: "default" }));
        expect(mockSendOwnerCallMonitor).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), "dispatched");
        expect(res._status).toBe(200);
        expect(res._json.success).toBe(true);
    });
    it("skips SMS when no dispatch_text_numbers", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({ dispatch_text_numbers: [] });
        mockAgentIdToSlug["agent_1"] = "acme";
        const res = makeRes();
        await postHookHandler(makeReq(makeBody()), res);
        expect(mockSendSmsToAll).not.toHaveBeenCalled();
        expect(mockSendEmail).toHaveBeenCalled();
    });
    it("skips email when no dispatch_email", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({ dispatch_email: null });
        mockAgentIdToSlug["agent_1"] = "acme";
        const res = makeRes();
        await postHookHandler(makeReq(makeBody()), res);
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockSendSmsToAll).toHaveBeenCalled();
    });
    it("returns 500 when notification dispatch errors", async () => {
        mockAgentIdToClient["agent_1"] = makeClient();
        mockAgentIdToSlug["agent_1"] = "acme";
        mockSendSmsToAll.mockRejectedValue(new Error("twilio-down"));
        const res = makeRes();
        await postHookHandler(makeReq(makeBody()), res);
        expect(res._status).toBe(500);
        expect(res._json.success).toBe(false);
        expect(res._json.errors).toEqual(expect.arrayContaining([expect.stringContaining("twilio-down")]));
        expect(mockSaveCallLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "dispatch_error" }));
    });
});
describe("postHookHandler — shadow mode", () => {
    it("dry-runs notifications to owner instead of client", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({ shadow_mode: true });
        mockAgentIdToSlug["agent_1"] = "acme";
        const res = makeRes();
        await postHookHandler(makeReq(makeBody()), res);
        expect(res._json.outcome).toBe("shadow_dry_run");
        // sendSmsToAll called with owner phone, not the client's dispatch number
        expect(mockSendSmsToAll).toHaveBeenCalled();
        const smsArgs = mockSendSmsToAll.mock.calls[0];
        expect(smsArgs[0]).not.toEqual(["+15550001111"]); // not the client's number
        expect(mockSendEmail).toHaveBeenCalled();
        const emailArgs = mockSendEmail.mock.calls[0][0];
        expect(emailArgs.subject).toContain("[SHADOW DRY-RUN]");
    });
    it("redirects shadow dispatch_call to owner phone when summary_agent_id is set", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({
            shadow_mode: true,
            summary_agent_id: "agent_summary",
        });
        mockAgentIdToSlug["agent_1"] = "acme";
        await postHookHandler(makeReq(makeBody()), makeRes());
        expect(mockTriggerDispatchCall).toHaveBeenCalledTimes(1);
        const passedClient = mockTriggerDispatchCall.mock.calls[0][0];
        expect(passedClient.dispatch_call_number).not.toBe("+15550001111");
    });
});
describe("postHookHandler — surge alerts", () => {
    it("sends owner SMS + email when call surge fires", async () => {
        mockAgentIdToClient["agent_1"] = makeClient();
        mockAgentIdToSlug["agent_1"] = "acme";
        mockCheckAgentAlerts.mockReturnValue({
            callSurge: { fired: true, count: 17 },
            costSurge: { fired: false, totalCents: 0 },
        });
        await postHookHandler(makeReq(makeBody()), makeRes());
        // surge owner alert SMS
        const surgeSms = mockSendSms.mock.calls.find(([_, body]) => String(body).includes("CALL SURGE"));
        expect(surgeSms).toBeTruthy();
        // surge owner email
        const surgeEmail = mockSendEmail.mock.calls.find(([args]) => args.subject.includes("CALL SURGE"));
        expect(surgeEmail).toBeTruthy();
    });
    it("sends cost surge owner SMS + email", async () => {
        mockAgentIdToClient["agent_1"] = makeClient();
        mockAgentIdToSlug["agent_1"] = "acme";
        mockCheckAgentAlerts.mockReturnValue({
            callSurge: { fired: false, count: 0 },
            costSurge: { fired: true, totalCents: 1500 },
        });
        await postHookHandler(makeReq(makeBody()), makeRes());
        const costSms = mockSendSms.mock.calls.find(([_, body]) => String(body).includes("COST SURGE"));
        expect(costSms).toBeTruthy();
        const costEmail = mockSendEmail.mock.calls.find(([args]) => args.subject.includes("$15.00"));
        expect(costEmail).toBeTruthy();
    });
});
describe("postHookHandler — dispatch call routing", () => {
    it("triggers dispatch call when dispatch_call_number is set", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({
            dispatch_call_number: "+15550005555",
        });
        mockAgentIdToSlug["agent_1"] = "acme";
        await postHookHandler(makeReq(makeBody()), makeRes());
        expect(mockTriggerDispatchCall).toHaveBeenCalledTimes(1);
        const passedClient = mockTriggerDispatchCall.mock.calls[0][0];
        expect(passedClient.dispatch_call_number).toBe("+15550005555");
    });
    it("skips dispatch call when caller was live-transferred", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({
            dispatch_call_number: "+15550005555",
        });
        mockAgentIdToSlug["agent_1"] = "acme";
        const body = makeBody({ call: { disconnection_reason: "call_transfer" } });
        await postHookHandler(makeReq(body), makeRes());
        expect(mockTriggerDispatchCall).not.toHaveBeenCalled();
    });
    it("uses dispatch_call_overrides for the to_number", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({
            dispatch_call_number: null,
            dispatch_call_overrides: { "+15550001111": "+15558888888" },
        });
        mockAgentIdToSlug["agent_1"] = "acme";
        await postHookHandler(makeReq(makeBody()), makeRes());
        expect(mockTriggerDispatchCall).toHaveBeenCalledTimes(1);
        expect(mockTriggerDispatchCall.mock.calls[0][0].dispatch_call_number).toBe("+15558888888");
    });
    it("skips dispatch call when no number is configured", async () => {
        mockAgentIdToClient["agent_1"] = makeClient(); // dispatch_call_number is null
        mockAgentIdToSlug["agent_1"] = "acme";
        await postHookHandler(makeReq(makeBody()), makeRes());
        expect(mockTriggerDispatchCall).not.toHaveBeenCalled();
    });
});
describe("postHookHandler — webhook callback", () => {
    it("posts to webhook_url when configured", async () => {
        mockAgentIdToClient["agent_1"] = makeClient({ webhook_url: "https://hook.example/x" });
        mockAgentIdToSlug["agent_1"] = "acme";
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal("fetch", fetchMock);
        await postHookHandler(makeReq(makeBody()), makeRes());
        expect(fetchMock).toHaveBeenCalledWith("https://hook.example/x", expect.objectContaining({ method: "POST" }));
        vi.unstubAllGlobals();
    });
    it("does not post when webhook_url is missing", async () => {
        mockAgentIdToClient["agent_1"] = makeClient();
        mockAgentIdToSlug["agent_1"] = "acme";
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await postHookHandler(makeReq(makeBody()), makeRes());
        expect(fetchMock).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});
