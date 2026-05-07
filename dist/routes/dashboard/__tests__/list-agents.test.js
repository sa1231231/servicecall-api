import { describe, it, expect, vi, beforeEach } from "vitest";
// ── Mocks ──────────────────────────────────────────────────────────────────
const { mockGetAllClientDocuments, mockDriftAggregate } = vi.hoisted(() => ({
    mockGetAllClientDocuments: vi.fn(),
    mockDriftAggregate: vi.fn(),
}));
vi.mock("../../../config/client-store.js", () => ({
    getAllClientDocuments: (...args) => mockGetAllClientDocuments(...args),
}));
// list-agents.ts imports billing-cogs.js, which transitively pulls in db.js
// and config.js. Mock billing-cogs to keep that chain out of the test worker.
vi.mock("../../../lib/billing-cogs.js", () => ({
    getMtdCogsForAllClients: vi.fn().mockResolvedValue({}),
}));
// list-agents.ts also imports db.js directly for the drift aggregation
// (`agent_versions` collection).
vi.mock("../../../lib/db.js", () => ({
    getDb: () => ({
        collection: (_name) => ({
            aggregate: (pipeline) => ({
                toArray: () => mockDriftAggregate(pipeline),
            }),
        }),
    }),
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
        agent_id: "agent_1",
        ...overrides,
    };
}
// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
    vi.clearAllMocks();
    // Default: no drift detected. Tests that need drift override per-case.
    mockDriftAggregate.mockResolvedValue([]);
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
    it("attaches drift_detected_at when agent_versions has a recent auto_sync entry", async () => {
        const driftAt = new Date("2026-04-01T12:00:00Z");
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockDriftAggregate.mockResolvedValue([
            { _id: "test-co", lastDriftAt: driftAt },
        ]);
        const res = mockRes();
        await listAgentsHandler({}, res);
        expect(res._json[0].drift_detected_at).toBe(driftAt.toISOString());
        // Pipeline must filter on source + description + a 24h cutoff.
        const pipeline = mockDriftAggregate.mock.calls[0][0];
        const match = pipeline.find((s) => s.$match)?.$match;
        expect(match.source).toBe("auto_sync");
        expect(match.description).toBe("Auto-sync drift detected");
        expect(match.createdAt.$gte).toBeInstanceOf(Date);
    });
    it("returns drift_detected_at: null when no drift entry exists", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockDriftAggregate.mockResolvedValue([]);
        const res = mockRes();
        await listAgentsHandler({}, res);
        expect(res._json[0].drift_detected_at).toBeNull();
    });
    it("falls through with empty drift map when the aggregation throws", async () => {
        mockGetAllClientDocuments.mockResolvedValue([makeDoc()]);
        mockDriftAggregate.mockRejectedValue(new Error("agent_versions unreachable"));
        const spy = vi.spyOn(console, "error").mockImplementation(() => { });
        const res = mockRes();
        await listAgentsHandler({}, res);
        expect(res._status).toBe(200);
        expect(res._json[0].drift_detected_at).toBeNull();
        spy.mockRestore();
    });
});
