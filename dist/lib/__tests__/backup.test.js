import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockS3Send, mockFind, mockConfig, } = vi.hoisted(() => ({
    mockS3Send: vi.fn(),
    mockFind: vi.fn(),
    mockConfig: {
        R2_ENDPOINT: "https://r2.example",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "secret",
        R2_BUCKET: "test-bucket",
    },
}));
vi.mock("../../config.js", () => ({
    get config() {
        return mockConfig;
    },
}));
vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: class {
        send = mockS3Send;
    },
    PutObjectCommand: class {
        input;
        constructor(input) { this.input = input; }
        static commandName = "PutObjectCommand";
    },
    ListObjectsV2Command: class {
        input;
        constructor(input) { this.input = input; }
        static commandName = "ListObjectsV2Command";
    },
    DeleteObjectsCommand: class {
        input;
        constructor(input) { this.input = input; }
        static commandName = "DeleteObjectsCommand";
    },
}));
vi.mock("../db.js", () => ({
    getDb: () => ({
        collection: () => ({
            find: () => ({ toArray: mockFind }),
        }),
    }),
}));
const { runBackup, isR2Configured } = await import("../backup.js");
beforeEach(() => {
    vi.clearAllMocks();
    // Reset config to fully-configured
    mockConfig.R2_ENDPOINT = "https://r2.example";
    mockConfig.R2_ACCESS_KEY_ID = "key";
    mockConfig.R2_SECRET_ACCESS_KEY = "secret";
    mockConfig.R2_BUCKET = "test-bucket";
    mockFind.mockResolvedValue([]);
    mockS3Send.mockResolvedValue({});
});
describe("isR2Configured", () => {
    it("returns true when all R2 env vars are set", () => {
        expect(isR2Configured()).toBe(true);
    });
    it("returns false when R2_ENDPOINT is empty", () => {
        mockConfig.R2_ENDPOINT = "";
        expect(isR2Configured()).toBe(false);
    });
    it("returns false when R2_ACCESS_KEY_ID is empty", () => {
        mockConfig.R2_ACCESS_KEY_ID = "";
        expect(isR2Configured()).toBe(false);
    });
    it("returns false when R2_SECRET_ACCESS_KEY is empty", () => {
        mockConfig.R2_SECRET_ACCESS_KEY = "";
        expect(isR2Configured()).toBe(false);
    });
});
describe("runBackup", () => {
    it("returns success: false when R2 is not configured", async () => {
        mockConfig.R2_ENDPOINT = "";
        const result = await runBackup();
        expect(result.success).toBe(false);
        expect(result.error).toContain("R2 not configured");
        expect(mockS3Send).not.toHaveBeenCalled();
    });
    it("dumps all 4 collections, gzips, and uploads", async () => {
        // Each collection returns 2 docs
        mockFind.mockResolvedValue([{ _id: "doc1" }, { _id: "doc2" }]);
        const result = await runBackup();
        expect(result.success).toBe(true);
        expect(result.key).toMatch(/^backups\/\d{4}-\d{2}-\d{2}_\d{2}00\.json\.gz$/);
        // Should have called find().toArray() once per collection (4 collections)
        expect(mockFind).toHaveBeenCalledTimes(4);
        // PutObjectCommand was sent
        const putCall = mockS3Send.mock.calls.find(([cmd]) => cmd.constructor.commandName === "PutObjectCommand");
        expect(putCall).toBeDefined();
        expect(putCall[0].input).toMatchObject({
            Bucket: "test-bucket",
            ContentType: "application/gzip",
        });
        expect(putCall[0].input.Body).toBeInstanceOf(Buffer);
        expect(putCall[0].input.Key).toBe(result.key);
    });
    it("includes all 4 collection names in key generation flow", async () => {
        const collectionsRead = [];
        // We can detect collection names indirectly via call count = 4
        mockFind.mockResolvedValue([]);
        await runBackup();
        expect(mockFind).toHaveBeenCalledTimes(4);
    });
    it("returns success: false on PutObjectCommand error", async () => {
        mockS3Send.mockImplementation((cmd) => {
            if (cmd.constructor.commandName === "PutObjectCommand") {
                return Promise.reject(new Error("upload-fail"));
            }
            return Promise.resolve({});
        });
        const result = await runBackup();
        expect(result.success).toBe(false);
        expect(result.error).toBe("upload-fail");
    });
    it("calls cleanupOldBackups after successful upload", async () => {
        await runBackup();
        const listCall = mockS3Send.mock.calls.find(([cmd]) => cmd.constructor.commandName === "ListObjectsV2Command");
        expect(listCall).toBeDefined();
        expect(listCall[0].input).toMatchObject({
            Bucket: "test-bucket",
            Prefix: "backups/",
        });
    });
    it("deletes backups older than 30 days", async () => {
        const oldDate = new Date();
        oldDate.setDate(oldDate.getDate() - 45);
        const recentDate = new Date();
        mockS3Send.mockImplementation((cmd) => {
            if (cmd.constructor.commandName === "ListObjectsV2Command") {
                return Promise.resolve({
                    Contents: [
                        { Key: "backups/old.json.gz", LastModified: oldDate },
                        { Key: "backups/recent.json.gz", LastModified: recentDate },
                    ],
                });
            }
            return Promise.resolve({});
        });
        await runBackup();
        const deleteCall = mockS3Send.mock.calls.find(([cmd]) => cmd.constructor.commandName === "DeleteObjectsCommand");
        expect(deleteCall).toBeDefined();
        expect(deleteCall[0].input.Delete.Objects).toEqual([{ Key: "backups/old.json.gz" }]);
    });
    it("does not call DeleteObjectsCommand when nothing to delete", async () => {
        mockS3Send.mockImplementation((cmd) => {
            if (cmd.constructor.commandName === "ListObjectsV2Command") {
                return Promise.resolve({ Contents: [] });
            }
            return Promise.resolve({});
        });
        await runBackup();
        const deleteCall = mockS3Send.mock.calls.find(([cmd]) => cmd.constructor.commandName === "DeleteObjectsCommand");
        expect(deleteCall).toBeUndefined();
    });
    it("swallows cleanup errors without affecting overall success", async () => {
        mockS3Send.mockImplementation((cmd) => {
            if (cmd.constructor.commandName === "ListObjectsV2Command") {
                return Promise.reject(new Error("list-fail"));
            }
            return Promise.resolve({});
        });
        const err = vi.spyOn(console, "error").mockImplementation(() => { });
        const result = await runBackup();
        // Cleanup is wrapped in try/catch internally — backup still succeeds.
        expect(result.success).toBe(true);
        expect(err).toHaveBeenCalledWith(expect.stringContaining("cleanup failed"), "list-fail");
        err.mockRestore();
    });
});
