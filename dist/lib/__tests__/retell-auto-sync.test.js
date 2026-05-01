import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const { mockGetAllClientDocuments, mockLoadClientsFromDb, mockFetchRetellAgent, mockDeriveNotificationConfig, mockCreateVersionSnapshot, mockUpdateOne, } = vi.hoisted(() => ({
    mockGetAllClientDocuments: vi.fn(),
    mockLoadClientsFromDb: vi.fn(),
    mockFetchRetellAgent: vi.fn(),
    mockDeriveNotificationConfig: vi.fn(),
    mockCreateVersionSnapshot: vi.fn(),
    mockUpdateOne: vi.fn(),
}));
vi.mock("../../config.js", () => ({
    config: { RETELL_API_KEY: "retell_test" },
}));
vi.mock("retell-sdk", () => ({
    default: class {
    },
}));
vi.mock("../../config/client-store.js", () => ({
    getAllClientDocuments: (...a) => mockGetAllClientDocuments(...a),
    loadClientsFromDb: (...a) => mockLoadClientsFromDb(...a),
}));
vi.mock("../retell-sync.js", () => ({
    fetchRetellAgent: (...a) => mockFetchRetellAgent(...a),
}));
vi.mock("../notification-config.js", () => ({
    deriveNotificationConfig: (...a) => mockDeriveNotificationConfig(...a),
}));
vi.mock("../agent-versions.js", () => ({
    createVersionSnapshot: (...a) => mockCreateVersionSnapshot(...a),
}));
vi.mock("../db.js", () => ({
    getDb: () => ({
        collection: () => ({ updateOne: mockUpdateOne }),
    }),
}));
const { startAutoSync } = await import("../retell-auto-sync.js");
function makeDoc(overrides = {}) {
    return {
        _id: "acme",
        name: "Acme",
        agent_ids: ["agent_1"],
        dispatch_text_numbers: [],
        dispatch_call_number: null,
        dispatch_email: null,
        dispatch_cc: null,
        outbound_from_number: null,
        summary_agent_id: null,
        phone_fallback_to_caller: false,
        hide_not_mentioned: false,
        shadow_mode: false,
        message_types: {},
        default_message_type: "default",
        retell_agents: {
            agent_1: {
                conversationFlow: { nodes: [{ id: "n1" }, { id: "n2" }], global_prompt: "old" },
            },
        },
        ...overrides,
    };
}
function makeSnapshot(overrides = {}) {
    return {
        agentId: "agent_1",
        agentName: "Agent 1",
        conversationFlowId: "cf_1",
        variables: [],
        canonicalJson: {
            conversationFlow: { nodes: [{ id: "n1" }, { id: "n2" }], global_prompt: "old" },
        },
        ...overrides,
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockDeriveNotificationConfig.mockReturnValue({
        message_types: {},
        default_message_type: "default",
        resolve_rule: undefined,
    });
    mockUpdateOne.mockResolvedValue({});
});
afterEach(() => {
    vi.useRealTimers();
});
function captureRunFn() {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    startAutoSync();
    const fn = setIntervalSpy.mock.calls[0][0];
    setIntervalSpy.mockRestore();
    return fn;
}
describe("startAutoSync", () => {
    it("registers a 3-minute interval", () => {
        const setIntervalSpy = vi.spyOn(global, "setInterval");
        startAutoSync();
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(setIntervalSpy.mock.calls[0][1]).toBe(3 * 60_000);
        setIntervalSpy.mockRestore();
    });
});
describe("runAutoSync (via captured interval fn)", () => {
    it("syncs an agent and writes the canonical JSON to MongoDB", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockFetchRetellAgent.mockResolvedValue(makeSnapshot());
        const run = captureRunFn();
        await run();
        expect(mockFetchRetellAgent).toHaveBeenCalledWith(expect.any(Object), "agent_1");
        expect(mockUpdateOne).toHaveBeenCalledWith({ _id: "acme" }, expect.objectContaining({
            $set: expect.objectContaining({
                "retell_agents.agent_1": expect.any(Object),
            }),
        }));
        expect(mockLoadClientsFromDb).toHaveBeenCalledTimes(1);
    });
    it("skips clients deployed within the last 10 minutes", async () => {
        const recent = new Date(Date.now() - 5 * 60_000).toISOString();
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc({ last_deployed_at: recent }),
        ]);
        const run = captureRunFn();
        await run();
        expect(mockFetchRetellAgent).not.toHaveBeenCalled();
        expect(mockUpdateOne).not.toHaveBeenCalled();
    });
    it("does not skip when last_deployed_at is older than 10 minutes", async () => {
        const old = new Date(Date.now() - 60 * 60_000).toISOString();
        mockGetAllClientDocuments.mockResolvedValue([makeDoc({ last_deployed_at: old })]);
        mockFetchRetellAgent.mockResolvedValue(makeSnapshot());
        const run = captureRunFn();
        await run();
        expect(mockFetchRetellAgent).toHaveBeenCalled();
    });
    it("skips clients with no agent_ids", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc({ agent_ids: [] })]);
        const run = captureRunFn();
        await run();
        expect(mockFetchRetellAgent).not.toHaveBeenCalled();
        // No sync occurred, so cache reload should NOT happen
        expect(mockLoadClientsFromDb).not.toHaveBeenCalled();
    });
    it("creates a version snapshot when node count drifts", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockFetchRetellAgent.mockResolvedValue(makeSnapshot({
            canonicalJson: {
                conversationFlow: { nodes: [{ id: "n1" }], global_prompt: "old" }, // 1 node, was 2
            },
        }));
        const run = captureRunFn();
        await run();
        expect(mockCreateVersionSnapshot).toHaveBeenCalledWith("acme", "agent_1", expect.any(Object), "auto_sync", expect.any(String), "system");
    });
    it("creates a snapshot when global_prompt changes", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockFetchRetellAgent.mockResolvedValue(makeSnapshot({
            canonicalJson: {
                conversationFlow: { nodes: [{ id: "n1" }, { id: "n2" }], global_prompt: "NEW PROMPT" },
            },
        }));
        const run = captureRunFn();
        await run();
        expect(mockCreateVersionSnapshot).toHaveBeenCalled();
    });
    it("does NOT snapshot when there's no significant drift", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockFetchRetellAgent.mockResolvedValue(makeSnapshot()); // identical
        const run = captureRunFn();
        await run();
        expect(mockCreateVersionSnapshot).not.toHaveBeenCalled();
    });
    it("logs and continues when a single agent sync fails", async () => {
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc({ _id: "a", agent_ids: ["agent_a"] }),
            makeDoc({ _id: "b", agent_ids: ["agent_b"] }),
        ]);
        mockFetchRetellAgent
            .mockRejectedValueOnce(new Error("retell-down"))
            .mockResolvedValueOnce(makeSnapshot({ agentId: "agent_b" }));
        const err = vi.spyOn(console, "error").mockImplementation(() => { });
        const run = captureRunFn();
        await run();
        expect(mockUpdateOne).toHaveBeenCalledTimes(1); // only the second one
        expect(err).toHaveBeenCalledWith(expect.stringContaining("retell-down"));
        err.mockRestore();
    });
    it("swallows snapshot errors without aborting the sync", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockFetchRetellAgent.mockResolvedValue(makeSnapshot({
            canonicalJson: { conversationFlow: { nodes: [{ id: "n1" }], global_prompt: "x" } },
        }));
        mockCreateVersionSnapshot.mockRejectedValue(new Error("snap-fail"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const run = captureRunFn();
        await run();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not snapshot drift"), expect.any(Error));
        expect(mockUpdateOne).toHaveBeenCalledTimes(1); // sync still completed
        warn.mockRestore();
    });
    it("preserves message_types when keys differ from derived (multi-path agents)", async () => {
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc({
                message_types: {
                    path_a: { label: "A", subject_template: "", fields: [] },
                    path_b: { label: "B", subject_template: "", fields: [] },
                },
            }),
        ]);
        mockFetchRetellAgent.mockResolvedValue(makeSnapshot());
        mockDeriveNotificationConfig.mockReturnValue({
            message_types: { default: { label: "Default", subject_template: "", fields: [] } },
            default_message_type: "default",
        });
        const run = captureRunFn();
        await run();
        const update = mockUpdateOne.mock.calls[0][1].$set;
        expect(update).not.toHaveProperty("message_types");
        expect(update).not.toHaveProperty("default_message_type");
    });
    it("does not refresh the cache when nothing was synced", async () => {
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc({ agent_ids: [] }),
        ]);
        const run = captureRunFn();
        await run();
        expect(mockLoadClientsFromDb).not.toHaveBeenCalled();
    });
});
