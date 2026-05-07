import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRes, makeReq, makeDoc, runRoute as runRouteHelper } from "./node-editor-helpers.js";
const { mockAgentUpdate, mockFlowUpdate, mockGetClientDocument, mockLoadClientsFromDb, mockGetDb, mockUpdateOne, mockFetchRetellAgent, mockPushFlowToRetell, mockExtractVariables, mockParseConversationFlow, mockValidateConversationFlow, mockCreateVersionSnapshot, mockLogAudit, mockDeriveNotificationConfig, mockRequireRoot, } = vi.hoisted(() => ({
    mockAgentUpdate: vi.fn(),
    mockFlowUpdate: vi.fn(),
    mockGetClientDocument: vi.fn(),
    mockLoadClientsFromDb: vi.fn(),
    mockGetDb: vi.fn(),
    mockUpdateOne: vi.fn(),
    mockFetchRetellAgent: vi.fn(),
    mockPushFlowToRetell: vi.fn(),
    mockExtractVariables: vi.fn(),
    mockParseConversationFlow: vi.fn(),
    mockValidateConversationFlow: vi.fn(),
    mockCreateVersionSnapshot: vi.fn(),
    mockLogAudit: vi.fn(),
    mockDeriveNotificationConfig: vi.fn(),
    mockRequireRoot: vi.fn(),
}));
vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key" } }));
vi.mock("retell-sdk", () => ({
    default: class {
        conversationFlow = { update: mockFlowUpdate };
        agent = { update: mockAgentUpdate };
    },
}));
vi.mock("../../../config/client-store.js", () => ({
    getClientDocument: (...a) => mockGetClientDocument(...a),
    loadClientsFromDb: (...a) => mockLoadClientsFromDb(...a),
}));
vi.mock("../../../lib/db.js", () => ({ getDb: (...a) => mockGetDb(...a) }));
vi.mock("../../../lib/retell-sync.js", () => ({
    fetchRetellAgent: (...a) => mockFetchRetellAgent(...a),
    pushFlowToRetell: (...a) => mockPushFlowToRetell(...a),
    extractVariables: (...a) => mockExtractVariables(...a),
}));
vi.mock("../../../lib/node-parser.js", () => ({
    parseConversationFlow: (...a) => mockParseConversationFlow(...a),
}));
vi.mock("../../../lib/node-validator.js", () => ({
    validateConversationFlow: (...a) => mockValidateConversationFlow(...a),
}));
vi.mock("../../../lib/agent-versions.js", () => ({
    createVersionSnapshot: (...a) => mockCreateVersionSnapshot(...a),
    getVersion: vi.fn(),
    listVersions: vi.fn(),
    getLatestVersion: vi.fn(),
}));
vi.mock("../../../lib/audit.js", () => ({
    logAudit: (...a) => mockLogAudit(...a),
}));
vi.mock("../../../lib/notification-config.js", () => ({
    deriveNotificationConfig: (...a) => mockDeriveNotificationConfig(...a),
}));
vi.mock("../../../middleware/require-role.js", () => ({
    requireRoot: (req, res, next) => mockRequireRoot(req, res, next),
}));
vi.mock("../../../lib/node-regenerator.js", () => ({
    regenerateDataChain: vi.fn(),
    applyRegeneratedChain: vi.fn(),
}));
vi.mock("../../../lib/data-point-defaults.js", () => ({ getDataPointDefaults: vi.fn() }));
vi.mock("../../../lib/agent-generator/generate-agent.js", () => ({ resolveDataPoints: vi.fn() }));
vi.mock("../../../lib/agent-generator/data-point-registry.js", () => ({ PATH_TAKEN_VAR: "path_taken" }));
vi.mock("../../../lib/agent-generator/node-builders.js", () => ({
    makeIdFactory: vi.fn(),
    buildTransitionNode: vi.fn(),
    buildDataChain: vi.fn(),
    buildWarmTransferOption: vi.fn(),
    DEFAULT_LIVE_TRANSFER_RECOVERY_PROMPT: "fallback prompt",
}));
vi.mock("../../../lib/agent-generator/warm-transfer-agent-version.js", () => ({
    getWarmTransferAgentVersion: vi.fn(),
}));
vi.mock("../../../lib/build-notification.js", () => ({ renderTemplate: (s) => s }));
const { nodeEditorRouter } = await import("../node-editor.js");
const runRoute = (method, path, req, res) => runRouteHelper(nodeEditorRouter, method, path, req, res);
// ── Test fixture: a minimal multi-path canonical flow ──────────────────────
//
// Two paths (Service, Sales). Each has a transition node + a single
// data-point chain (collect → confirm). The intro node carries existing
// finetune_transition_examples representing both per-path positives and an
// agent-level negative (no destination).
function buildFlow() {
    const introNode = {
        id: "intro-1",
        name: "Intro",
        type: "conversation",
        edges: [
            { id: "e-svc", destination_node_id: "trans-service", transition_condition: { type: "prompt", prompt: "service" } },
            { id: "e-sales", destination_node_id: "trans-sales", transition_condition: { type: "prompt", prompt: "sales" } },
        ],
        finetune_transition_examples: [
            // Existing example targeting Service path
            {
                id: "ft-existing-service",
                transcript: [{ content: "old service", role: "user" }],
                destination_node_id: "trans-service",
            },
            // Existing example targeting Sales path
            {
                id: "ft-existing-sales",
                transcript: [{ content: "old sales", role: "user" }],
                destination_node_id: "trans-sales",
            },
            // Agent-level negative — no destination, must always be preserved
            {
                id: "ft-agent-neg",
                transcript: [{ content: "irrelevant", role: "user" }],
            },
        ],
        instruction: { type: "prompt", text: "intro" },
    };
    const collectService = {
        id: "collect-svc",
        name: "Collect Name (Service)",
        type: "conversation",
        instruction: { type: "prompt", text: "ask name" },
        finetune_transition_examples: [],
    };
    const collectSales = {
        id: "collect-sales",
        name: "Collect Name (Sales)",
        type: "conversation",
        instruction: { type: "prompt", text: "ask name" },
        finetune_transition_examples: [],
    };
    const transService = { id: "trans-service", name: "Transition (Service)", type: "conversation", instruction: { text: "" } };
    const transSales = { id: "trans-sales", name: "Transition (Sales)", type: "conversation", instruction: { text: "" } };
    const flow = {
        nodes: [introNode, transService, transSales, collectService, collectSales],
        global_prompt: "g",
    };
    const canonicalJson = { conversationFlow: flow };
    const parsed = {
        introNode: { id: "intro-1", raw: introNode },
        paths: [
            {
                name: "Service",
                endMode: "callback",
                transitionNode: { id: "trans-service" },
                routerNode: { id: "router-svc" },
                closeNode: { id: "close-svc" },
                dataChain: [
                    {
                        variableName: "full_name",
                        collectNode: { id: "collect-svc" },
                        confirmNode: { id: "confirm-svc" },
                    },
                ],
            },
            {
                name: "Sales",
                endMode: "callback",
                transitionNode: { id: "trans-sales" },
                routerNode: { id: "router-sales" },
                closeNode: { id: "close-sales" },
                dataChain: [
                    {
                        variableName: "full_name",
                        collectNode: { id: "collect-sales" },
                        confirmNode: { id: "confirm-sales" },
                    },
                ],
            },
        ],
        faqNode: null,
        closeNode: null,
        allNodes: flow.nodes,
    };
    return { canonicalJson, flow, parsed, introNode, collectService, collectSales };
}
beforeEach(() => {
    for (const m of [
        mockAgentUpdate, mockFlowUpdate, mockGetClientDocument, mockLoadClientsFromDb,
        mockGetDb, mockUpdateOne, mockFetchRetellAgent, mockPushFlowToRetell,
        mockExtractVariables, mockParseConversationFlow, mockValidateConversationFlow,
        mockCreateVersionSnapshot, mockLogAudit, mockDeriveNotificationConfig, mockRequireRoot,
    ])
        m.mockReset();
    mockUpdateOne.mockResolvedValue({});
    mockGetDb.mockReturnValue({ collection: () => ({ updateOne: mockUpdateOne }) });
    mockLoadClientsFromDb.mockResolvedValue(undefined);
    mockExtractVariables.mockReturnValue([]);
    mockDeriveNotificationConfig.mockReturnValue({ message_types: {}, default_message_type: null });
    mockValidateConversationFlow.mockReturnValue([]);
    mockCreateVersionSnapshot.mockResolvedValue({});
    mockLogAudit.mockResolvedValue({});
    mockAgentUpdate.mockResolvedValue(undefined);
    mockFlowUpdate.mockResolvedValue(undefined);
    mockPushFlowToRetell.mockResolvedValue(undefined);
    mockRequireRoot.mockImplementation((_req, _res, next) => next());
});
describe("POST /:agentId/save-and-publish — fine-tune mutations", () => {
    it("dataPointFinetunes replaces a collect node's finetune_transition_examples and resolves destination to the confirm node", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson,
            conversationFlowId: "f1",
            agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        const newExample = {
            type: "positive",
            transcript: [{ content: "John Smith", role: "user" }],
            id: "ft-new-1",
        };
        const res = makeRes();
        await runRoute("post", "/:agentId/save-and-publish", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: { changes: { dataPointFinetunes: { "collect-svc": [newExample] } } },
            username: "alice",
        }), res);
        expect(res._status).toBe(200);
        expect(fix.collectService.finetune_transition_examples).toHaveLength(1);
        const written = fix.collectService.finetune_transition_examples[0];
        expect(written.id).toBe("ft-new-1");
        expect(written.destination_node_id).toBe("confirm-svc");
        expect(JSON.stringify(written.transcript)).toContain("John Smith");
        expect(mockPushFlowToRetell).toHaveBeenCalledTimes(1);
    });
    it("negative dataPointFinetunes are written without a destination_node_id (agent stays in collect)", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson, conversationFlowId: "f1", agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        const negEx = {
            type: "negative",
            transcript: [{ content: "uh I don't know", role: "user" }],
            id: "ft-neg",
        };
        const res = makeRes();
        await runRoute("post", "/:agentId/save-and-publish", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: { changes: { dataPointFinetunes: { "collect-svc": [negEx] } } },
        }), res);
        expect(res._status).toBe(200);
        const written = fix.collectService.finetune_transition_examples[0];
        expect(written.destination_node_id).toBeUndefined();
    });
    it("transitionFinetunes replaces the intro node's per-path examples while preserving other paths and agent-level entries", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson, conversationFlowId: "f1", agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        const newServiceEx = {
            type: "positive",
            transcript: [{ content: "I want service", role: "user" }],
            id: "ft-new-service",
        };
        const res = makeRes();
        await runRoute("post", "/:agentId/save-and-publish", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: { changes: { transitionFinetunes: { Service: [newServiceEx] } } },
        }), res);
        expect(res._status).toBe(200);
        const examples = fix.introNode.finetune_transition_examples;
        // Old Service example removed; new Service example added.
        expect(examples.find((e) => e.id === "ft-existing-service")).toBeUndefined();
        expect(examples.find((e) => e.id === "ft-new-service")).toBeDefined();
        expect(examples.find((e) => e.id === "ft-new-service").destination_node_id).toBe("trans-service");
        // Sales path's existing example untouched (we didn't mutate Sales).
        expect(examples.find((e) => e.id === "ft-existing-sales")).toBeDefined();
        // Agent-level negative example preserved.
        expect(examples.find((e) => e.id === "ft-agent-neg")).toBeDefined();
    });
    it("transitionFinetunes can clear a path's examples by passing an empty array", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson, conversationFlowId: "f1", agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        const res = makeRes();
        await runRoute("post", "/:agentId/save-and-publish", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: { changes: { transitionFinetunes: { Service: [] } } },
        }), res);
        expect(res._status).toBe(200);
        const examples = fix.introNode.finetune_transition_examples;
        // Service entry removed; Sales + agent-level still present.
        expect(examples.find((e) => e.destination_node_id === "trans-service")).toBeUndefined();
        expect(examples.find((e) => e.id === "ft-existing-sales")).toBeDefined();
        expect(examples.find((e) => e.id === "ft-agent-neg")).toBeDefined();
    });
    it("multiple paths can be edited in a single request", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson, conversationFlowId: "f1", agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        const res = makeRes();
        await runRoute("post", "/:agentId/save-and-publish", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: {
                changes: {
                    transitionFinetunes: {
                        Service: [{ type: "positive", transcript: [{ content: "S", role: "user" }], id: "ft-s" }],
                        Sales: [{ type: "positive", transcript: [{ content: "X", role: "user" }], id: "ft-x" }],
                    },
                },
            },
        }), res);
        expect(res._status).toBe(200);
        const examples = fix.introNode.finetune_transition_examples;
        expect(examples.find((e) => e.id === "ft-s").destination_node_id).toBe("trans-service");
        expect(examples.find((e) => e.id === "ft-x").destination_node_id).toBe("trans-sales");
        // Both old per-path entries replaced; agent-level kept.
        expect(examples.find((e) => e.id === "ft-existing-service")).toBeUndefined();
        expect(examples.find((e) => e.id === "ft-existing-sales")).toBeUndefined();
        expect(examples.find((e) => e.id === "ft-agent-neg")).toBeDefined();
    });
    it("pushes the modified flow to Retell after applying fine-tune mutations", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson, conversationFlowId: "f1", agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        const res = makeRes();
        await runRoute("post", "/:agentId/save-and-publish", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: {
                changes: {
                    dataPointFinetunes: {
                        "collect-svc": [{ type: "positive", transcript: [{ content: "x", role: "user" }] }],
                    },
                },
            },
        }), res);
        expect(res._status).toBe(200);
        expect(mockPushFlowToRetell).toHaveBeenCalledTimes(1);
        // The third positional arg is the canonical JSON we pushed.
        const [, , pushed] = mockPushFlowToRetell.mock.calls[0];
        const flow = pushed.conversationFlow;
        const collect = flow.nodes.find((n) => n.id === "collect-svc");
        expect(collect.finetune_transition_examples).toHaveLength(1);
    });
});
// ── POST /:agentId/validate — dry-run path ───────────────────────────────────
//
// /validate is implemented as a thin alias over the same handler with
// dryRun=true. These tests assert that the side effects (Retell push, Mongo
// snapshot, audit log) DO NOT fire on the dry-run path, regardless of whether
// validation succeeds or fails.
describe("POST /:agentId/validate", () => {
    it("returns { ok: true, errors: [] } and skips push + snapshot when validation passes", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson, conversationFlowId: "f1", agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        mockValidateConversationFlow.mockReturnValue([]);
        const res = makeRes();
        await runRoute("post", "/:agentId/validate", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: { changes: { description: "cleanup" } },
        }), res);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ ok: true, errors: [] });
        expect(mockPushFlowToRetell).not.toHaveBeenCalled();
        expect(mockCreateVersionSnapshot).not.toHaveBeenCalled();
        expect(mockLogAudit).not.toHaveBeenCalled();
    });
    it("returns 400 with the validator's errors and still skips push/snapshot", async () => {
        const fix = buildFlow();
        mockGetClientDocument.mockResolvedValue(makeDoc());
        mockFetchRetellAgent.mockResolvedValue({
            canonicalJson: fix.canonicalJson, conversationFlowId: "f1", agentName: "Acme",
        });
        mockParseConversationFlow.mockReturnValue(fix.parsed);
        mockValidateConversationFlow.mockReturnValue([
            { code: "ORPHAN", message: "node X has no incoming edge" },
        ]);
        const res = makeRes();
        await runRoute("post", "/:agentId/validate", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: { changes: { description: "broken" } },
        }), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toBe("Validation failed");
        expect(res._json.errors).toEqual([
            { code: "ORPHAN", message: "node X has no incoming edge" },
        ]);
        expect(mockPushFlowToRetell).not.toHaveBeenCalled();
        expect(mockCreateVersionSnapshot).not.toHaveBeenCalled();
    });
    it("rejects missing changes object with 400 (same shape as save-and-publish)", async () => {
        const res = makeRes();
        await runRoute("post", "/:agentId/validate", makeReq({
            params: { slug: "acme", agentId: "agent_1" },
            body: {},
        }), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toMatch(/changes/);
    });
});
