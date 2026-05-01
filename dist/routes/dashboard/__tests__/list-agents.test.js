import { describe, it, expect, vi, beforeEach } from "vitest";
// ── Mocks ──────────────────────────────────────────────────────────────────
const { mockGetAllClientDocuments } = vi.hoisted(() => ({
    mockGetAllClientDocuments: vi.fn(),
}));
vi.mock("../../../config/client-store.js", () => ({
    getAllClientDocuments: (...args) => mockGetAllClientDocuments(...args),
}));
import { listAgentsHandler } from "../list-agents.js";
// ── Helpers ────────────────────────────────────────────────────────────────
function mockRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
function makeDoc(overrides = {}) {
    return {
        _id: "test-co",
        name: "Test Co",
        shadow_mode: false,
        agent_ids: ["agent_1"],
        ...overrides,
    };
}
// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
    vi.clearAllMocks();
});
describe("listAgentsHandler", () => {
    it("includes active field in response", async () => {
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc({ active: true }),
        ]);
        const res = mockRes();
        await listAgentsHandler({}, res);
        expect(res._json).toHaveLength(1);
        expect(res._json[0].active).toBe(true);
    });
    it("returns active: undefined when not set on document", async () => {
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc(), // no active field
        ]);
        const res = mockRes();
        await listAgentsHandler({}, res);
        expect(res._json[0].active).toBeUndefined();
    });
    it("returns active: false for inactive agents", async () => {
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc({ active: false }),
        ]);
        const res = mockRes();
        await listAgentsHandler({}, res);
        expect(res._json[0].active).toBe(false);
    });
    it("defaults trial_start_date to null when missing", async () => {
        mockGetAllClientDocuments.mockResolvedValue([
            makeDoc(), // no trial_start_date
        ]);
        const res = mockRes();
        await listAgentsHandler({}, res);
        expect(res._json[0].trial_start_date).toBeNull();
    });
});
