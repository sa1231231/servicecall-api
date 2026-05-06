import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockFlowCreate, mockFlowDelete, mockAgentCreate, mockNotificationClients, mockGetClientDocument, mockPersistClient, mockFetchRetellAgent, mockExtractFlowParams, mockExtractAgentParams, mockGenerateSlug, } = vi.hoisted(() => ({
    mockFlowCreate: vi.fn(),
    mockFlowDelete: vi.fn(),
    mockAgentCreate: vi.fn(),
    mockNotificationClients: {},
    mockGetClientDocument: vi.fn(),
    mockPersistClient: vi.fn(),
    mockFetchRetellAgent: vi.fn(),
    mockExtractFlowParams: vi.fn(),
    mockExtractAgentParams: vi.fn(),
    mockGenerateSlug: vi.fn(),
}));
vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key" } }));
vi.mock("retell-sdk", () => ({
    default: class {
        conversationFlow = { create: mockFlowCreate, delete: mockFlowDelete };
        agent = { create: mockAgentCreate };
    },
}));
vi.mock("../../../_cache/clients.js", () => ({ notificationClients: mockNotificationClients }));
vi.mock("../../../config/client-store.js", () => ({
    getClientDocument: (...a) => mockGetClientDocument(...a),
    persistClient: (...a) => mockPersistClient(...a),
}));
vi.mock("../../../lib/retell-sync.js", () => ({
    fetchRetellAgent: (...a) => mockFetchRetellAgent(...a),
    extractFlowParams: (...a) => mockExtractFlowParams(...a),
    extractAgentParams: (...a) => mockExtractAgentParams(...a),
}));
vi.mock("../../../lib/slug.js", () => ({ generateSlug: (...a) => mockGenerateSlug(...a) }));
const { cloneAgentHandler } = await import("../clone-agent.js");
function makeRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
function makeReq(opts) {
    return { params: opts.params ?? {}, body: opts.body ?? {} };
}
beforeEach(() => {
    for (const m of [
        mockFlowCreate, mockFlowDelete, mockAgentCreate,
        mockGetClientDocument, mockPersistClient, mockFetchRetellAgent,
        mockExtractFlowParams, mockExtractAgentParams, mockGenerateSlug,
    ])
        m.mockReset();
    for (const k of Object.keys(mockNotificationClients))
        delete mockNotificationClients[k];
    mockPersistClient.mockResolvedValue(undefined);
    mockGenerateSlug.mockImplementation((name) => name.toLowerCase().replace(/\s+/g, "-"));
    mockExtractFlowParams.mockReturnValue({});
    mockExtractAgentParams.mockReturnValue({});
});
describe("cloneAgentHandler", () => {
    it("returns 400 when name missing", async () => {
        const res = makeRes();
        await cloneAgentHandler(makeReq({ params: { slug: "src" }, body: { faq: "f" } }), res);
        expect(res._status).toBe(400);
    });
    it("returns 400 when faq missing", async () => {
        const res = makeRes();
        await cloneAgentHandler(makeReq({ params: { slug: "src" }, body: { name: "n" } }), res);
        expect(res._status).toBe(400);
    });
    it("returns 404 when source client not found", async () => {
        mockGetClientDocument.mockResolvedValue(null);
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" }, body: { name: "New", faq: "fff" },
        }), res);
        expect(res._status).toBe(404);
    });
    it("returns 400 when source client has no agent_id", async () => {
        mockGetClientDocument.mockResolvedValue({ name: "Old" });
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" }, body: { name: "New", faq: "fff" },
        }), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/no agent_id/);
    });
    it("returns 409 when generated slug already exists", async () => {
        mockGetClientDocument.mockResolvedValue({ name: "Old", agent_id: "agent_1" });
        mockNotificationClients["new-co"] = {};
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" }, body: { name: "New Co", faq: "fff" },
        }), res);
        expect(res._status).toBe(409);
    });
    it("clones successfully: creates flow + agent, persists client, returns 201", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Old", agent_id: "agent_src",
            message_types: { default: { fields: [] } },
            default_message_type: "default",
            summary_agent_id: "sum_agent",
        });
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: {
                conversationFlow: {
                    nodes: [
                        { name: "Greeting", instruction: { text: "Hi from Old, welcome to Old" } },
                        { name: "Admin/FAQ", instruction: { text: "Your goal is to answer administrative and general questions briefly and accurately.\n\nold faq" } },
                    ],
                },
            },
        });
        mockFlowCreate.mockResolvedValue({ conversation_flow_id: "flow_NEW", nodes: [] });
        mockAgentCreate.mockResolvedValue({ agent_id: "agent_NEW" });
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" }, body: { name: "New Co", faq: "new faq content" },
        }), res);
        expect(res._status).toBe(201);
        expect(res._json).toMatchObject({
            success: true, agent_id: "agent_NEW", source_slug: "src", slug: "new-co",
        });
        expect(mockFlowCreate).toHaveBeenCalled();
        expect(mockAgentCreate).toHaveBeenCalled();
        // Business name replacement should have happened in the flow before flow.create
        const flowParamsCall = mockExtractFlowParams.mock.calls[0][0];
        const greeting = flowParamsCall.nodes.find((n) => n.name === "Greeting");
        expect(greeting.instruction.text).toMatch(/New Co/);
        expect(greeting.instruction.text).not.toMatch(/Old/);
        // FAQ should be replaced
        const faqNode = flowParamsCall.nodes.find((n) => n.name === "Admin/FAQ");
        expect(faqNode.instruction.text).toContain("new faq content");
        expect(faqNode.instruction.text).not.toContain("old faq");
        // Persisted entry should default to shadow_mode: true
        const persisted = mockPersistClient.mock.calls[0][1];
        expect(persisted.shadow_mode).toBe(true);
        expect(persisted.summary_agent_id).toBe("sum_agent");
    });
    it("uses provided dispatch fields, defaults to null/empty when omitted", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Old", agent_id: "agent_src",
            message_types: { default: { fields: [] } },
        });
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: { conversationFlow: { nodes: [] } },
        });
        mockFlowCreate.mockResolvedValue({ conversation_flow_id: "flow_NEW" });
        mockAgentCreate.mockResolvedValue({ agent_id: "agent_NEW" });
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" },
            body: {
                name: "New", faq: "x",
                dispatch_text_numbers: ["+1"],
                dispatch_email: ["a@b.com"],
            },
        }), res);
        expect(res._status).toBe(201);
        const persisted = mockPersistClient.mock.calls[0][1];
        expect(persisted.dispatch_text_numbers).toEqual(["+1"]);
        expect(persisted.dispatch_email).toEqual(["a@b.com"]);
        expect(persisted.dispatch_call_number).toBeNull();
        expect(persisted.dispatch_cc).toBeNull();
        expect(persisted.outbound_from_number).toBeNull();
    });
    it("cleans up flow when agent.create fails", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Old", agent_id: "agent_src",
            message_types: { default: { fields: [] } },
        });
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: { conversationFlow: { nodes: [] } },
        });
        mockFlowCreate.mockResolvedValue({ conversation_flow_id: "flow_NEW" });
        mockAgentCreate.mockRejectedValue(new Error("create failed"));
        mockFlowDelete.mockResolvedValue(undefined);
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" }, body: { name: "New", faq: "x" },
        }), res);
        expect(res._status).toBe(502);
        expect(res._json.details).toBe("create failed");
        expect(mockFlowDelete).toHaveBeenCalledWith("flow_NEW");
        expect(mockPersistClient).not.toHaveBeenCalled();
    });
    it("does not call cleanup when fetch fails before flow created", async () => {
        mockGetClientDocument.mockResolvedValue({
            name: "Old", agent_id: "agent_src",
            message_types: { default: { fields: [] } },
        });
        mockFetchRetellAgent.mockRejectedValue(new Error("not found"));
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" }, body: { name: "New", faq: "x" },
        }), res);
        expect(res._status).toBe(502);
        expect(mockFlowDelete).not.toHaveBeenCalled();
    });
    it("preserves resolve_rules from source via deep clone", async () => {
        const sourceRules = [{ if: "x", equals: "y", then: "z" }];
        mockGetClientDocument.mockResolvedValue({
            name: "Old", agent_id: "agent_src",
            message_types: { default: { fields: [] } },
            resolve_rules: sourceRules,
        });
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: { conversationFlow: { nodes: [] } },
        });
        mockFlowCreate.mockResolvedValue({ conversation_flow_id: "flow_NEW" });
        mockAgentCreate.mockResolvedValue({ agent_id: "agent_NEW" });
        const res = makeRes();
        await cloneAgentHandler(makeReq({
            params: { slug: "src" }, body: { name: "New", faq: "x" },
        }), res);
        expect(res._status).toBe(201);
        const persisted = mockPersistClient.mock.calls[0][1];
        expect(persisted.resolve_rules).toEqual(sourceRules);
        // Must be a deep clone, not the same reference
        expect(persisted.resolve_rules).not.toBe(sourceRules);
    });
});
