import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockInsertOne, mockFindOne, mockFind, mockCountDocuments, mockDeleteMany, mockCreateIndex } = vi.hoisted(() => ({
    mockInsertOne: vi.fn(),
    mockFindOne: vi.fn(),
    mockFind: vi.fn(),
    mockCountDocuments: vi.fn(),
    mockDeleteMany: vi.fn(),
    mockCreateIndex: vi.fn(),
}));
vi.mock("../db.js", () => ({
    getDb: () => ({
        collection: () => ({
            insertOne: mockInsertOne,
            findOne: mockFindOne,
            find: mockFind,
            countDocuments: mockCountDocuments,
            deleteMany: mockDeleteMany,
            createIndex: mockCreateIndex,
        }),
    }),
}));
const { createVersionSnapshot, listVersions, getVersion, getLatestVersion, ensureVersionIndexes, } = await import("../agent-versions.js");
const { ObjectId } = await import("mongodb");
function chainableFind(items, total = items.length) {
    return {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(items),
        _total: total,
    };
}
beforeEach(() => {
    vi.clearAllMocks();
});
describe("createVersionSnapshot", () => {
    it("starts at version 1 when no prior versions exist and writes correct shape", async () => {
        mockFindOne.mockResolvedValueOnce(null); // getNextVersionNumber → no latest
        const insertedId = new ObjectId();
        mockInsertOne.mockResolvedValue({ insertedId });
        mockCountDocuments.mockResolvedValue(1);
        const canonical = {
            conversationFlow: {
                nodes: [
                    { id: "n1", type: "extract_dynamic_variables", variables: [{ name: "full_name" }, { name: "city" }] },
                    { id: "n2", type: "conversation" },
                ],
            },
        };
        const result = await createVersionSnapshot("acme", "agent_x", canonical, "manual_edit", "test edit", "alice");
        expect(mockInsertOne).toHaveBeenCalledTimes(1);
        const doc = mockInsertOne.mock.calls[0][0];
        expect(doc).toMatchObject({
            slug: "acme",
            agentId: "agent_x",
            version: 1,
            source: "manual_edit",
            description: "test edit",
            createdBy: "alice",
            nodeCount: 2,
            dataPointCount: 2,
        });
        expect(doc.createdAt).toBeInstanceOf(Date);
        expect(result._id).toBe(insertedId);
    });
    it("increments version from latest stored version", async () => {
        mockFindOne.mockResolvedValueOnce({ version: 7 });
        mockInsertOne.mockResolvedValue({ insertedId: new ObjectId() });
        mockCountDocuments.mockResolvedValue(8);
        await createVersionSnapshot("acme", "agent_x", { conversationFlow: {} }, "auto_sync", "drift", "system");
        expect(mockInsertOne.mock.calls[0][0].version).toBe(8);
    });
    it("counts zero nodes/data-points when conversationFlow is missing", async () => {
        mockFindOne.mockResolvedValueOnce(null);
        mockInsertOne.mockResolvedValue({ insertedId: new ObjectId() });
        mockCountDocuments.mockResolvedValue(1);
        await createVersionSnapshot("acme", "agent_x", {}, "creation", "init", "system");
        const doc = mockInsertOne.mock.calls[0][0];
        expect(doc.nodeCount).toBe(0);
        expect(doc.dataPointCount).toBe(0);
    });
    it("deduplicates data point variable names across nodes", async () => {
        mockFindOne.mockResolvedValueOnce(null);
        mockInsertOne.mockResolvedValue({ insertedId: new ObjectId() });
        mockCountDocuments.mockResolvedValue(1);
        const canonical = {
            conversationFlow: {
                nodes: [
                    { type: "extract_dynamic_variables", variables: [{ name: "full_name" }, { name: "city" }] },
                    { type: "extract_dynamic_variables", variables: [{ name: "city" }, { name: "issue" }] },
                ],
            },
        };
        await createVersionSnapshot("acme", "agent_x", canonical, "manual_edit", "", "user");
        expect(mockInsertOne.mock.calls[0][0].dataPointCount).toBe(3);
    });
    it("deletes oldest versions when count exceeds the 50-version cap", async () => {
        mockFindOne.mockResolvedValueOnce({ version: 50 });
        mockInsertOne.mockResolvedValue({ insertedId: new ObjectId() });
        mockCountDocuments.mockResolvedValue(52); // 2 over cap
        const oldest = [{ _id: new ObjectId() }, { _id: new ObjectId() }];
        mockFind.mockReturnValueOnce(chainableFind(oldest));
        mockDeleteMany.mockResolvedValue({ deletedCount: 2 });
        await createVersionSnapshot("acme", "agent_x", {}, "manual_edit", "", "u");
        expect(mockDeleteMany).toHaveBeenCalledWith({
            _id: { $in: oldest.map((d) => d._id) },
        });
    });
    it("does not delete when count is within the cap", async () => {
        mockFindOne.mockResolvedValueOnce({ version: 5 });
        mockInsertOne.mockResolvedValue({ insertedId: new ObjectId() });
        mockCountDocuments.mockResolvedValue(6);
        await createVersionSnapshot("acme", "agent_x", {}, "manual_edit", "", "u");
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });
});
describe("listVersions", () => {
    it("returns versions newest-first and total count", async () => {
        const versions = [{ version: 3 }, { version: 2 }];
        const findCursor = chainableFind(versions);
        mockFind.mockReturnValueOnce(findCursor);
        mockCountDocuments.mockResolvedValue(3);
        const result = await listVersions("acme", "agent_x");
        expect(findCursor.sort).toHaveBeenCalledWith({ version: -1 });
        expect(findCursor.limit).toHaveBeenCalledWith(20);
        expect(findCursor.skip).toHaveBeenCalledWith(0);
        expect(result.versions).toEqual(versions);
        expect(result.total).toBe(3);
    });
    it("respects custom limit and offset", async () => {
        const findCursor = chainableFind([]);
        mockFind.mockReturnValueOnce(findCursor);
        mockCountDocuments.mockResolvedValue(0);
        await listVersions("acme", "agent_x", { limit: 5, offset: 10 });
        expect(findCursor.limit).toHaveBeenCalledWith(5);
        expect(findCursor.skip).toHaveBeenCalledWith(10);
    });
});
describe("getVersion / getLatestVersion", () => {
    it("getVersion returns the doc when found", async () => {
        const id = new ObjectId();
        const doc = { _id: id, slug: "acme", agentId: "agent_x", version: 4 };
        mockFindOne.mockResolvedValue(doc);
        const result = await getVersion(id.toString());
        expect(mockFindOne).toHaveBeenCalledWith({ _id: expect.any(ObjectId) });
        const calledId = mockFindOne.mock.calls[0][0]._id;
        expect(calledId.toString()).toBe(id.toString());
        expect(result).toEqual(doc);
    });
    it("getVersion returns null when missing", async () => {
        const id = new ObjectId();
        mockFindOne.mockResolvedValue(null);
        expect(await getVersion(id.toString())).toBeNull();
    });
    it("getLatestVersion sorts by version desc", async () => {
        mockFindOne.mockResolvedValue({ version: 9 });
        await getLatestVersion("acme", "agent_x");
        expect(mockFindOne).toHaveBeenCalledWith({ slug: "acme", agentId: "agent_x" }, { sort: { version: -1 } });
    });
    it("getLatestVersion returns null when no versions exist", async () => {
        mockFindOne.mockResolvedValue(null);
        expect(await getLatestVersion("acme", "agent_x")).toBeNull();
    });
});
describe("ensureVersionIndexes", () => {
    it("creates a composite slug+agentId+version index and a 90-day TTL index", async () => {
        mockCreateIndex.mockResolvedValue("ok");
        await ensureVersionIndexes();
        expect(mockCreateIndex).toHaveBeenCalledWith({ slug: 1, agentId: 1, version: -1 });
        expect(mockCreateIndex).toHaveBeenCalledWith({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });
    });
    it("is idempotent — calling twice does not throw", async () => {
        mockCreateIndex.mockResolvedValue("ok");
        await ensureVersionIndexes();
        await ensureVersionIndexes();
        expect(mockCreateIndex.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
});
