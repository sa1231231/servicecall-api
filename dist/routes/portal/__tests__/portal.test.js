import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockValidatePortalToken, mockFindClientsByEmail, mockGeneratePortalToken, mockGetClientDocument, mockUpdateClientFields, mockLoadClientsFromDb, mockSendEmail, mockLogAudit, mockGetCallLogsByClient, mockOwnerConfig, } = vi.hoisted(() => ({
    mockValidatePortalToken: vi.fn(),
    mockFindClientsByEmail: vi.fn(),
    mockGeneratePortalToken: vi.fn(),
    mockGetClientDocument: vi.fn(),
    mockUpdateClientFields: vi.fn(),
    mockLoadClientsFromDb: vi.fn(),
    mockSendEmail: vi.fn(),
    mockLogAudit: vi.fn(),
    mockGetCallLogsByClient: vi.fn(),
    mockOwnerConfig: { phone: "+15550000000", email: "owner@x.com" },
}));
vi.mock("../../../config/client-store.js", () => ({
    validatePortalToken: (...a) => mockValidatePortalToken(...a),
    findClientsByEmail: (...a) => mockFindClientsByEmail(...a),
    generatePortalToken: (...a) => mockGeneratePortalToken(...a),
    getClientDocument: (...a) => mockGetClientDocument(...a),
    updateClientFields: (...a) => mockUpdateClientFields(...a),
    loadClientsFromDb: (...a) => mockLoadClientsFromDb(...a),
}));
vi.mock("../../../lib/notify-email.js", () => ({
    sendEmail: (...a) => mockSendEmail(...a),
}));
vi.mock("../../../config/notification-clients.js", () => ({
    ownerConfig: mockOwnerConfig,
}));
vi.mock("../../../lib/audit.js", () => ({
    logAudit: (...a) => mockLogAudit(...a),
}));
vi.mock("../../../lib/call-log.js", () => ({
    getCallLogsByClient: (...a) => mockGetCallLogsByClient(...a),
}));
const { portalRouter } = await import("../index.js");
const { portalGetAgentHandler } = await import("../get-agent.js");
const { portalGetCallsHandler } = await import("../get-calls.js");
function makeRes() {
    const res = { _status: 200, _json: null, _html: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    res.type = () => res;
    res.send = (data) => { res._html = data; return res; };
    return res;
}
function makeReq(opts) {
    const headers = { host: opts.host ?? "localhost:3000" };
    return {
        params: opts.params ?? {},
        body: opts.body ?? {},
        query: opts.query ?? {},
        protocol: opts.protocol ?? "https",
        headers,
        get: (h) => headers[h.toLowerCase()],
    };
}
function findRoute(method, path) {
    for (const layer of portalRouter.stack) {
        if (!layer.route)
            continue;
        if (layer.route.path === path && layer.route.methods[method])
            return layer.route.stack;
    }
    throw new Error(`Route not found: ${method} ${path}`);
}
async function runRoute(method, path, req, res) {
    const stack = findRoute(method, path);
    for (let i = 0; i < stack.length; i++) {
        let advance = false;
        let nextErr = null;
        const next = (err) => { if (err)
            nextErr = err; advance = true; };
        const result = stack[i].handle(req, res, next);
        if (result && typeof result.then === "function")
            await result;
        if (nextErr)
            throw nextErr;
        if (!advance)
            return;
    }
}
beforeEach(() => {
    for (const m of [
        mockValidatePortalToken, mockFindClientsByEmail, mockGeneratePortalToken,
        mockGetClientDocument, mockUpdateClientFields, mockLoadClientsFromDb,
        mockSendEmail, mockLogAudit, mockGetCallLogsByClient,
    ])
        m.mockReset();
    mockUpdateClientFields.mockResolvedValue(undefined);
    mockLoadClientsFromDb.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    mockSendEmail.mockResolvedValue(undefined);
});
// ── POST /request-link ─────────────────────────────────────────────────────
describe("POST /request-link", () => {
    it("returns generic success when email empty (no enumeration)", async () => {
        const res = makeRes();
        await runRoute("post", "/request-link", makeReq({ body: { email: "" } }), res);
        expect(res._status).toBe(200);
        expect(res._json.success).toBe(true);
        expect(mockFindClientsByEmail).not.toHaveBeenCalled();
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
    it("returns generic success when email malformed", async () => {
        const res = makeRes();
        await runRoute("post", "/request-link", makeReq({ body: { email: "no-at-symbol" } }), res);
        expect(res._status).toBe(200);
        expect(res._json.success).toBe(true);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
    it("returns generic success even when no clients match", async () => {
        mockFindClientsByEmail.mockResolvedValue([]);
        const res = makeRes();
        await runRoute("post", "/request-link", makeReq({ body: { email: "stranger@x.com" } }), res);
        expect(res._status).toBe(200);
        expect(res._json.success).toBe(true);
        expect(mockSendEmail).not.toHaveBeenCalled();
    });
    it("sends links for each matched client (existing token reused)", async () => {
        mockFindClientsByEmail.mockResolvedValue([
            { _id: "acme", name: "Acme", portal_token: "tok-acme" },
            { _id: "beta", name: "Beta" }, // no token → must be generated
        ]);
        mockGeneratePortalToken.mockResolvedValue("tok-beta-new");
        const res = makeRes();
        await runRoute("post", "/request-link", makeReq({ body: { email: "alice@example.com" }, host: "app.example.com", protocol: "https" }), res);
        expect(res._status).toBe(200);
        expect(mockGeneratePortalToken).toHaveBeenCalledWith("beta");
        expect(mockGeneratePortalToken).not.toHaveBeenCalledWith("acme"); // existing token reused
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        const sent = mockSendEmail.mock.calls[0][0];
        expect(sent.to).toBe("alice@example.com");
        expect(sent.body).toContain("https://app.example.com/portal/acme?token=tok-acme");
        expect(sent.body).toContain("https://app.example.com/portal/beta?token=tok-beta-new");
    });
    it("returns success even if email send throws (caught internally)", async () => {
        mockFindClientsByEmail.mockResolvedValue([{ _id: "acme", name: "Acme", portal_token: "t1" }]);
        mockSendEmail.mockRejectedValue(new Error("smtp down"));
        const res = makeRes();
        await runRoute("post", "/request-link", makeReq({ body: { email: "a@b.com" } }), res);
        expect(res._status).toBe(200);
        expect(res._json.success).toBe(true);
    });
    it("normalizes email casing/whitespace", async () => {
        mockFindClientsByEmail.mockResolvedValue([]);
        const res = makeRes();
        await runRoute("post", "/request-link", makeReq({ body: { email: "  USER@Example.COM  " } }), res);
        expect(mockFindClientsByEmail).toHaveBeenCalledWith("user@example.com");
    });
});
// ── portalGetAgentHandler ──────────────────────────────────────────────────
describe("portalGetAgentHandler", () => {
    function makePortalReq(slug) {
        const req = makeReq({});
        req.portalSlug = slug;
        return req;
    }
    it("returns 404 when client not found", async () => {
        mockGetClientDocument.mockResolvedValue(null);
        const res = makeRes();
        await portalGetAgentHandler(makePortalReq("acme"), res);
        expect(res._status).toBe(404);
    });
    it("strips owner phone and email from dispatch lists", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Acme",
            shadow_mode: false,
            dispatch_text_numbers: ["+15550000000", "+15551111111"], // owner + customer
            dispatch_call_number: "+15550000000", // owner — should be hidden
            dispatch_email: ["owner@x.com", "customer@y.com"],
        });
        const res = makeRes();
        await portalGetAgentHandler(makePortalReq("acme"), res);
        expect(res._status).toBe(200);
        expect(res._json.dispatch_text_numbers).toEqual(["+15551111111"]);
        expect(res._json.dispatch_call_number).toBeNull();
        expect(res._json.dispatch_email).toEqual(["customer@y.com"]);
    });
    it("returns dispatch_email as null when filtered list is empty", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Acme",
            dispatch_email: ["owner@x.com"], // only owner
        });
        const res = makeRes();
        await portalGetAgentHandler(makePortalReq("acme"), res);
        expect(res._json.dispatch_email).toBeNull();
    });
    it("includes per-path dispatch overrides + path_labels when present", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Acme",
            dispatch_by_type: {
                sales: { dispatch_text_numbers: ["+15551111111"], dispatch_email: [] },
            },
            message_types: { sales: { label: "Sales Lead" } },
        });
        const res = makeRes();
        await portalGetAgentHandler(makePortalReq("acme"), res);
        expect(res._status).toBe(200);
        expect(res._json.dispatch_by_type.sales.dispatch_text_numbers).toEqual(["+15551111111"]);
        expect(res._json.path_labels.sales).toBe("Sales Lead");
    });
    it("omits dispatch_by_type when no overrides have user-visible values", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Acme",
            dispatch_by_type: {
                sales: { dispatch_call_number: "+15550000000" }, // owner only
            },
        });
        const res = makeRes();
        await portalGetAgentHandler(makePortalReq("acme"), res);
        expect(res._json.dispatch_by_type).toBeUndefined();
    });
    it("includes dispatch_call_overrides excluding owner-routed ones", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Acme",
            dispatch_call_overrides: {
                "+19990000001": "+15551111111",
                "+19990000002": "+15550000000", // owner — should be filtered
            },
        });
        const res = makeRes();
        await portalGetAgentHandler(makePortalReq("acme"), res);
        expect(res._json.dispatch_call_overrides).toEqual({ "+19990000001": "+15551111111" });
    });
});
// ── portalGetCallsHandler ──────────────────────────────────────────────────
describe("portalGetCallsHandler", () => {
    function makePortalReq(slug, query = {}) {
        const req = makeReq({ query });
        req.portalSlug = slug;
        return req;
    }
    it("returns sanitized calls, filtering shadow/test calls", async () => {
        mockGetCallLogsByClient.mockResolvedValue([
            { _id: "1", from_number: "+15551111111", outcome: "ok", duration_ms: 1000, secret_field: "x" },
            { _id: "2", from_number: "+15552222222", outcome: "shadow_dry_run" },
            { _id: "3", from_number: "unknown", outcome: "ok" },
            { _id: "4", from_number: "Web Call", outcome: "ok" },
        ]);
        const res = makeRes();
        await portalGetCallsHandler(makePortalReq("acme"), res);
        expect(res._status).toBe(200);
        expect(res._json).toHaveLength(1);
        expect(res._json[0]._id).toBe("1");
        // Internal fields should not leak
        expect(res._json[0]).not.toHaveProperty("secret_field");
    });
    it("clamps limit to 100", async () => {
        mockGetCallLogsByClient.mockResolvedValue([]);
        const res = makeRes();
        await portalGetCallsHandler(makePortalReq("acme", { limit: "5000" }), res);
        expect(mockGetCallLogsByClient).toHaveBeenCalledWith("acme", 100, 0);
    });
    it("uses default limit of 50 when limit not provided", async () => {
        mockGetCallLogsByClient.mockResolvedValue([]);
        const res = makeRes();
        await portalGetCallsHandler(makePortalReq("acme"), res);
        expect(mockGetCallLogsByClient).toHaveBeenCalledWith("acme", 50, 0);
    });
    it("returns 500 when call log query throws", async () => {
        mockGetCallLogsByClient.mockRejectedValue(new Error("db down"));
        const res = makeRes();
        await portalGetCallsHandler(makePortalReq("acme"), res);
        expect(res._status).toBe(500);
        expect(res._json.error).toBe("db down");
    });
});
// ── PATCH /:slug/api/settings ──────────────────────────────────────────────
describe("PATCH /:slug/api/settings", () => {
    beforeEach(() => {
        // portalAuth needs a passing token for this route
        mockValidatePortalToken.mockResolvedValue(true);
    });
    it("returns 401 when token missing", async () => {
        mockValidatePortalToken.mockResolvedValue(true); // not used because slug missing
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({ params: { slug: "acme" }, body: { dispatch_email: ["a@b.com"] }, query: {} }), res);
        expect(res._status).toBe(401);
    });
    it("returns 401 when token invalid", async () => {
        mockValidatePortalToken.mockResolvedValue(false);
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({ params: { slug: "acme" }, body: { dispatch_email: ["a@b.com"] }, query: { token: "bad" } }), res);
        expect(res._status).toBe(401);
    });
    it("returns 404 when client not found", async () => {
        mockGetClientDocument.mockResolvedValue(null);
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({ params: { slug: "acme" }, body: { dispatch_email: ["a@b.com"] }, query: { token: "t" } }), res);
        expect(res._status).toBe(404);
    });
    it("returns 400 when body empty", async () => {
        mockGetClientDocument.mockResolvedValue({});
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({ params: { slug: "acme" }, body: {}, query: { token: "t" } }), res);
        expect(res._status).toBe(400);
    });
    it("rejects invalid phone numbers", async () => {
        mockGetClientDocument.mockResolvedValue({});
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({
            params: { slug: "acme" },
            body: { dispatch_text_numbers: ["bad-phone"] },
            query: { token: "t" },
        }), res);
        expect(res._status).toBe(400);
        expect(res._json.errors[0]).toMatch(/Invalid phone/);
    });
    it("rejects invalid email", async () => {
        mockGetClientDocument.mockResolvedValue({});
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({
            params: { slug: "acme" },
            body: { dispatch_email: ["not-email"] },
            query: { token: "t" },
        }), res);
        expect(res._status).toBe(400);
    });
    it("preserves owner phone when stripping/adding from list", async () => {
        mockGetClientDocument
            .mockResolvedValueOnce({
            dispatch_text_numbers: ["+15550000000", "+15551111111"],
        })
            .mockResolvedValueOnce({
            dispatch_text_numbers: ["+15550000000", "+15553333333"],
        });
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({
            params: { slug: "acme" },
            body: { dispatch_text_numbers: ["+15553333333"] }, // owner not included by user
            query: { token: "t" },
        }), res);
        expect(res._status).toBe(200);
        const updateCall = mockUpdateClientFields.mock.calls[0];
        // Owner phone re-prepended
        expect(updateCall[1].dispatch_text_numbers).toEqual(["+15550000000", "+15553333333"]);
    });
    it("ignores unknown editable keys", async () => {
        mockGetClientDocument.mockResolvedValue({});
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({
            params: { slug: "acme" },
            body: { admin_password: "hax" }, // not in PORTAL_EDITABLE
            query: { token: "t" },
        }), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toBe("No valid fields to update");
    });
    it("updates successfully and audits", async () => {
        mockGetClientDocument
            .mockResolvedValueOnce({
            dispatch_email: ["owner@x.com", "old@y.com"],
        })
            .mockResolvedValueOnce({
            dispatch_email: ["owner@x.com", "new@y.com"],
        });
        const res = makeRes();
        await runRoute("patch", "/:slug/api/settings", makeReq({
            params: { slug: "acme" },
            body: { dispatch_email: ["new@y.com"] },
            query: { token: "t" },
        }), res);
        expect(res._status).toBe(200);
        expect(res._json.dispatch_email).toEqual(["new@y.com"]); // owner stripped from response
        expect(mockLogAudit).toHaveBeenCalled();
        expect(mockUpdateClientFields).toHaveBeenCalled();
        expect(mockLoadClientsFromDb).toHaveBeenCalled();
    });
});
