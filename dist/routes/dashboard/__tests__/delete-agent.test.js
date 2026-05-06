import { describe, it, expect, vi, beforeEach } from "vitest";
// ── Mocks ──────────────────────────────────────────────────────────────────
const mockRetrieve = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
vi.mock("retell-sdk", () => {
    return {
        default: class MockRetell {
            agent = {
                retrieve: mockRetrieve,
                update: mockUpdate,
                delete: mockDelete,
            };
        },
    };
});
vi.mock("../../../config.js", () => ({
    config: { RETELL_API_KEY: "test-key" },
}));
const mockGetClientDocument = vi.fn();
const mockSoftDeleteClient = vi.fn();
vi.mock("../../../config/client-store.js", () => ({
    getClientDocument: (...args) => mockGetClientDocument(...args),
    softDeleteClient: (...args) => mockSoftDeleteClient(...args),
}));
vi.mock("../../../lib/audit.js", () => ({
    logAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/root-alerts.js", () => ({
    alertRootIfNeeded: vi.fn(),
}));
import { deleteAgentHandler } from "../delete-agent.js";
// ── Helpers ────────────────────────────────────────────────────────────────
function mockReq(slug) {
    return {
        params: { slug },
        user: { username: "admin", role: "admin", permissions: {}, isRoot: true },
    };
}
function mockRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
    vi.clearAllMocks();
    mockSoftDeleteClient.mockResolvedValue(undefined);
});
describe("deleteAgentHandler", () => {
    it("returns 404 when client not found", async () => {
        mockGetClientDocument.mockResolvedValue(null);
        const res = mockRes();
        await deleteAgentHandler(mockReq("nonexistent"), res);
        expect(res._status).toBe(404);
        expect(res._json.error).toContain("not found");
    });
    it("renames Retell agents instead of deleting them", async () => {
        mockGetClientDocument.mockResolvedValue({
            agent_id: "agent_1",
            retell_agents: {
                agent_1: { conversationFlow: { conversation_flow_id: "flow_1" } },
            },
        });
        mockRetrieve.mockResolvedValue({ agent_name: "Acme Plumbing" });
        mockUpdate.mockResolvedValue({});
        const res = mockRes();
        await deleteAgentHandler(mockReq("acme"), res);
        // Should NOT have called delete
        expect(mockDelete).not.toHaveBeenCalled();
        // Should have retrieved then updated the name
        expect(mockRetrieve).toHaveBeenCalledWith("agent_1");
        expect(mockUpdate).toHaveBeenCalledWith("agent_1", {
            agent_name: expect.stringContaining("Acme Plumbing [DELETED"),
        });
        // Verify the suffix format
        const newName = mockUpdate.mock.calls[0][1].agent_name;
        expect(newName).toMatch(/Acme Plumbing \[DELETED — expires \d{4}-\d{2}-\d{2}\]$/);
        expect(res._json.success).toBe(true);
        expect(res._json.warnings).toBeUndefined();
    });
    it("soft-deletes client in MongoDB", async () => {
        mockGetClientDocument.mockResolvedValue({
            agent_id: "agent_1",
            retell_agents: { agent_1: {} },
        });
        mockRetrieve.mockResolvedValue({ agent_name: "Test" });
        mockUpdate.mockResolvedValue({});
        const res = mockRes();
        await deleteAgentHandler(mockReq("test-slug"), res);
        expect(mockSoftDeleteClient).toHaveBeenCalledWith("test-slug");
    });
    it("handles agent_id not in retell_agents map (belt-and-suspenders)", async () => {
        mockGetClientDocument.mockResolvedValue({
            agent_id: "agent_1",
            retell_agents: { agent_2: {} }, // agent_id not in the map
        });
        mockRetrieve.mockResolvedValue({ agent_name: "Agent" });
        mockUpdate.mockResolvedValue({});
        const res = mockRes();
        await deleteAgentHandler(mockReq("test"), res);
        // Both retell_agents entry AND agent_id (from belt-and-suspenders) renamed
        expect(mockRetrieve).toHaveBeenCalledTimes(2);
        expect(mockUpdate).toHaveBeenCalledTimes(2);
    });
    it("collects warnings when Retell rename fails", async () => {
        mockGetClientDocument.mockResolvedValue({
            agent_id: "agent_1",
            retell_agents: { agent_1: {} },
        });
        mockRetrieve.mockRejectedValue(new Error("Agent not found in Retell"));
        const res = mockRes();
        await deleteAgentHandler(mockReq("test"), res);
        expect(res._json.success).toBe(true);
        expect(res._json.warnings).toHaveLength(1);
        expect(res._json.warnings[0]).toContain("Agent not found in Retell");
    });
    it("expiry date is 30 days in the future", async () => {
        mockGetClientDocument.mockResolvedValue({
            agent_id: "agent_1",
            retell_agents: { agent_1: {} },
        });
        mockRetrieve.mockResolvedValue({ agent_name: "Test" });
        mockUpdate.mockResolvedValue({});
        const res = mockRes();
        await deleteAgentHandler(mockReq("test"), res);
        const newName = mockUpdate.mock.calls[0][1].agent_name;
        const dateMatch = newName.match(/expires (\d{4}-\d{2}-\d{2})/);
        expect(dateMatch).toBeTruthy();
        const expiryDate = new Date(dateMatch[1]);
        const now = new Date();
        const diffDays = Math.round((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        expect(diffDays).toBeGreaterThanOrEqual(29);
        expect(diffDays).toBeLessThanOrEqual(31);
    });
});
