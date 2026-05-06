import { describe, it, expect, vi, beforeEach } from "vitest";
import { NOT_MENTIONED, PHONE_COLLECTED_FLAG, PATH_TAKEN_VAR, INTERNAL_VARS, defaultExtractEquation, } from "../agent-generator/data-point-registry.js";
import { CATEGORY_ORDER, CATEGORY_LABELS } from "../data-point-defaults.js";
// Data points now live in MongoDB. These tests validate the types,
// constants, and helpers that remain in code.
describe("data-point-registry constants and helpers", () => {
    it("INTERNAL_VARS contains exactly the internal variable names", () => {
        expect(INTERNAL_VARS.has(PHONE_COLLECTED_FLAG)).toBe(true);
        expect(INTERNAL_VARS.has(PATH_TAKEN_VAR)).toBe(true);
        expect(INTERNAL_VARS.size).toBe(2);
    });
    it("defaultExtractEquation generates an existence + non-mentioned pair", () => {
        const eqs = defaultExtractEquation("test_var");
        expect(eqs).toHaveLength(2);
        expect(eqs[0]).toEqual({ left: "{{test_var}}", operator: "exists" });
        expect(eqs[1]).toEqual({ left: "{{test_var}}", operator: "!=", right: NOT_MENTIONED });
    });
});
describe("category configuration", () => {
    it("CATEGORY_ORDER has expected categories", () => {
        expect(CATEGORY_ORDER).toContain("caller_info");
        expect(CATEGORY_ORDER).toContain("trucking");
        expect(CATEGORY_ORDER).toContain("billing");
        expect(CATEGORY_ORDER).toContain("legal_intake");
        expect(CATEGORY_ORDER.length).toBeGreaterThanOrEqual(9);
    });
    it("every category in CATEGORY_ORDER has a label", () => {
        for (const cat of CATEGORY_ORDER) {
            expect(CATEGORY_LABELS[cat], `${cat} should have a label`).toBeTruthy();
        }
    });
});
// ── DB-backed CRUD (mocked) ─────────────────────────────────────────────────
const { mockFind, mockFindOne, mockFindOneAndUpdate, mockInsertOne, mockDeleteOne, mockBulkOp, mockBulkExecute, } = vi.hoisted(() => ({
    mockFind: vi.fn(),
    mockFindOne: vi.fn(),
    mockFindOneAndUpdate: vi.fn(),
    mockInsertOne: vi.fn(),
    mockDeleteOne: vi.fn(),
    mockBulkOp: vi.fn(),
    mockBulkExecute: vi.fn(),
}));
vi.mock("../db.js", () => ({
    getDb: () => ({
        collection: () => ({
            find: mockFind,
            findOne: mockFindOne,
            findOneAndUpdate: mockFindOneAndUpdate,
            insertOne: mockInsertOne,
            deleteOne: mockDeleteOne,
            initializeUnorderedBulkOp: () => ({
                find: (q) => ({
                    updateOne: (u) => mockBulkOp(q, u),
                }),
                execute: mockBulkExecute,
            }),
        }),
    }),
}));
const { getDataPointDefaults, getDataPointDefaultsWithCategory, getDataPointDefault, updateDataPointDefault, createDataPointDefault, deleteDataPointDefault, reorderDataPointDefaults, } = await import("../data-point-defaults.js");
beforeEach(() => {
    vi.clearAllMocks();
});
describe("getDataPointDefaults", () => {
    it("returns a map keyed by _id with _id stripped from values", async () => {
        const docs = [
            { _id: "full_name", label: "Name", variableName: "full_name" },
            { _id: "city", label: "City", variableName: "city" },
        ];
        mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue(docs) });
        const result = await getDataPointDefaults();
        expect(result.full_name).toEqual({ label: "Name", variableName: "full_name" });
        expect(result.city).toEqual({ label: "City", variableName: "city" });
        expect(result.full_name._id).toBeUndefined();
    });
    it("returns empty map when no docs", async () => {
        mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
        expect(await getDataPointDefaults()).toEqual({});
    });
});
describe("getDataPointDefaultsWithCategory", () => {
    it("returns map preserving category and sortOrder", async () => {
        const docs = [
            { _id: "full_name", label: "Name", variableName: "full_name", category: "caller_info", sortOrder: 0 },
        ];
        mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue(docs) });
        const result = await getDataPointDefaultsWithCategory();
        expect(result.full_name).toMatchObject({
            category: "caller_info",
            sortOrder: 0,
        });
    });
});
describe("getDataPointDefault", () => {
    it("returns the doc when found", async () => {
        const doc = { _id: "city", label: "City" };
        mockFindOne.mockResolvedValue(doc);
        expect(await getDataPointDefault("city")).toBe(doc);
        expect(mockFindOne).toHaveBeenCalledWith({ _id: "city" });
    });
    it("returns null when not found", async () => {
        mockFindOne.mockResolvedValue(null);
        expect(await getDataPointDefault("missing")).toBeNull();
    });
});
describe("updateDataPointDefault", () => {
    it("findOneAndUpdate with $set and returnDocument: after", async () => {
        const updated = { _id: "city", label: "Updated City" };
        mockFindOneAndUpdate.mockResolvedValue(updated);
        const result = await updateDataPointDefault("city", { label: "Updated City" });
        expect(mockFindOneAndUpdate).toHaveBeenCalledWith({ _id: "city" }, { $set: { label: "Updated City" } }, { returnDocument: "after" });
        expect(result).toBe(updated);
    });
    it("returns null when no doc matches", async () => {
        mockFindOneAndUpdate.mockResolvedValue(null);
        expect(await updateDataPointDefault("missing", { label: "x" })).toBeNull();
    });
});
describe("createDataPointDefault", () => {
    beforeEach(() => {
        mockFindOne.mockResolvedValue(null); // doesn't already exist
        mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
        mockInsertOne.mockResolvedValue({});
    });
    it("creates a new data point with provided fields", async () => {
        const result = await createDataPointDefault("custom_x", {
            label: "Custom X",
            type: "string",
            category: "caller_info",
        });
        expect(mockInsertOne).toHaveBeenCalledTimes(1);
        const inserted = mockInsertOne.mock.calls[0][0];
        expect(inserted._id).toBe("custom_x");
        expect(inserted.label).toBe("Custom X");
        expect(inserted.variableName).toBe("custom_x");
        expect(inserted.type).toBe("string");
        expect(inserted.category).toBe("caller_info");
        expect(inserted.sortOrder).toBe(0);
        expect(inserted.choices).toEqual([]);
        expect(inserted.description).toContain("custom_x");
        expect(inserted.description).toContain("Not Mentioned");
        expect(inserted.conversationPrompt).toContain("custom x");
        expect(inserted.forwardCondition).toContain("custom x");
        expect(Array.isArray(inserted.extractSuccessEquation)).toBe(true);
        // Returned value should not include _id
        expect(result._id).toBeUndefined();
        expect(result.label).toBe("Custom X");
    });
    it("defaults category to 'custom' when not provided", async () => {
        await createDataPointDefault("no_cat", { label: "No Cat" });
        expect(mockInsertOne.mock.calls[0][0].category).toBe("custom");
    });
    it("defaults type to 'string' when not provided", async () => {
        await createDataPointDefault("k", { label: "K" });
        expect(mockInsertOne.mock.calls[0][0].type).toBe("string");
    });
    it("uses provided choices for enum types", async () => {
        await createDataPointDefault("status", {
            label: "Status",
            type: "enum",
            choices: ["A", "B"],
        });
        const inserted = mockInsertOne.mock.calls[0][0];
        expect(inserted.choices).toEqual(["A", "B"]);
        expect(inserted.type).toBe("enum");
    });
    it("uses custom description/conversationPrompt/forwardCondition when provided", async () => {
        await createDataPointDefault("custom_x", {
            label: "Custom X",
            description: "custom desc",
            conversationPrompt: "custom prompt",
            forwardCondition: "custom forward",
        });
        const inserted = mockInsertOne.mock.calls[0][0];
        expect(inserted.description).toBe("custom desc");
        expect(inserted.conversationPrompt).toBe("custom prompt");
        expect(inserted.forwardCondition).toBe("custom forward");
    });
    it("places new item at end of category (sortOrder = max+1)", async () => {
        mockFind.mockReturnValue({
            toArray: vi.fn().mockResolvedValue([
                { _id: "a", sortOrder: 0 },
                { _id: "b", sortOrder: 5 },
                { _id: "c", sortOrder: 3 },
            ]),
        });
        await createDataPointDefault("new_one", { label: "New", category: "trucking" });
        expect(mockInsertOne.mock.calls[0][0].sortOrder).toBe(6);
    });
    it("throws when key already exists", async () => {
        mockFindOne.mockResolvedValue({ _id: "existing" });
        await expect(createDataPointDefault("existing", { label: "X" })).rejects.toThrow(/already exists/);
        expect(mockInsertOne).not.toHaveBeenCalled();
    });
});
describe("deleteDataPointDefault", () => {
    it("returns true when one was deleted", async () => {
        mockDeleteOne.mockResolvedValue({ deletedCount: 1 });
        expect(await deleteDataPointDefault("city")).toBe(true);
        expect(mockDeleteOne).toHaveBeenCalledWith({ _id: "city" });
    });
    it("returns false when nothing was deleted", async () => {
        mockDeleteOne.mockResolvedValue({ deletedCount: 0 });
        expect(await deleteDataPointDefault("missing")).toBe(false);
    });
});
describe("reorderDataPointDefaults", () => {
    it("queues bulk updateOne per item and executes", async () => {
        mockBulkExecute.mockResolvedValue({});
        await reorderDataPointDefaults([
            { key: "a", category: "caller_info", sortOrder: 0 },
            { key: "b", category: "caller_info", sortOrder: 1 },
            { key: "c", category: "trucking", sortOrder: 0 },
        ]);
        expect(mockBulkOp).toHaveBeenCalledTimes(3);
        expect(mockBulkOp).toHaveBeenCalledWith({ _id: "a" }, { $set: { category: "caller_info", sortOrder: 0 } });
        expect(mockBulkExecute).toHaveBeenCalledTimes(1);
    });
    it("does not call execute on empty input", async () => {
        await reorderDataPointDefaults([]);
        expect(mockBulkOp).not.toHaveBeenCalled();
        expect(mockBulkExecute).not.toHaveBeenCalled();
    });
});
