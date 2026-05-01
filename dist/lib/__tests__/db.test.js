import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockConnect, mockDb } = vi.hoisted(() => ({
    mockConnect: vi.fn(),
    mockDb: vi.fn(),
}));
vi.mock("../../config.js", () => ({
    config: { MONGODB_URL: "mongodb://test/db" },
}));
vi.mock("mongodb", () => ({
    MongoClient: class {
        connect = mockConnect;
        db = mockDb;
    },
}));
beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
});
describe("getDb", () => {
    it("throws when called before initDb", async () => {
        const { getDb } = await import("../db.js");
        expect(() => getDb()).toThrow(/not initialized/);
    });
    it("returns the cached Db instance after initDb", async () => {
        const fakeDb = { name: "fake" };
        mockConnect.mockResolvedValue(undefined);
        mockDb.mockReturnValue(fakeDb);
        const { initDb, getDb } = await import("../db.js");
        const returned = await initDb();
        expect(mockConnect).toHaveBeenCalledTimes(1);
        expect(mockDb).toHaveBeenCalledTimes(1);
        expect(returned).toBe(fakeDb);
        expect(getDb()).toBe(fakeDb);
    });
    it("propagates connect() errors", async () => {
        mockConnect.mockRejectedValue(new Error("can't reach mongo"));
        const { initDb } = await import("../db.js");
        await expect(initDb()).rejects.toThrow("can't reach mongo");
    });
});
