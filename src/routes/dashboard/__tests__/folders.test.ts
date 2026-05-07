import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { Request, Response } from "express";
import { makeRes, makeReq } from "./node-editor-helpers.js";

// Folder CRUD endpoint tests. Mongo is mocked at the getDb boundary so we
// can drive each handler directly.

const {
  mockFoldersFind,
  mockFoldersFindOne,
  mockFoldersInsertOne,
  mockFoldersFindOneAndUpdate,
  mockFoldersDeleteOne,
  mockClientsUpdateMany,
  mockClientsUpdateOne,
  mockGetClientDocument,
  mockUpdateClientFields,
  mockLoadClientsFromDb,
} = vi.hoisted(() => ({
  mockFoldersFind: vi.fn(),
  mockFoldersFindOne: vi.fn(),
  mockFoldersInsertOne: vi.fn(),
  mockFoldersFindOneAndUpdate: vi.fn(),
  mockFoldersDeleteOne: vi.fn(),
  mockClientsUpdateMany: vi.fn(),
  mockClientsUpdateOne: vi.fn(),
  mockGetClientDocument: vi.fn(),
  mockUpdateClientFields: vi.fn(),
  mockLoadClientsFromDb: vi.fn(),
}));

vi.mock("../../../lib/db.js", () => ({
  getDb: () => ({
    collection: (name: string) => {
      if (name === "agent_folders") {
        return {
          find: (...a: any[]) => mockFoldersFind(...a),
          findOne: (...a: any[]) => mockFoldersFindOne(...a),
          insertOne: (...a: any[]) => mockFoldersInsertOne(...a),
          findOneAndUpdate: (...a: any[]) => mockFoldersFindOneAndUpdate(...a),
          deleteOne: (...a: any[]) => mockFoldersDeleteOne(...a),
        };
      }
      if (name === "clients") {
        return {
          updateMany: (...a: any[]) => mockClientsUpdateMany(...a),
          updateOne: (...a: any[]) => mockClientsUpdateOne(...a),
        };
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
  }),
}));

vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
  updateClientFields: (...a: any[]) => mockUpdateClientFields(...a),
  loadClientsFromDb: (...a: any[]) => mockLoadClientsFromDb(...a),
}));

vi.mock("../../../lib/audit.js", () => ({ logAudit: vi.fn() }));

const folders = await import("../folders.js");
const moveAgentFolder = await import("../move-agent-folder.js");

beforeEach(() => {
  for (const m of [
    mockFoldersFind, mockFoldersFindOne, mockFoldersInsertOne,
    mockFoldersFindOneAndUpdate, mockFoldersDeleteOne,
    mockClientsUpdateMany, mockClientsUpdateOne,
    mockGetClientDocument, mockUpdateClientFields, mockLoadClientsFromDb,
  ]) m.mockReset();

  mockLoadClientsFromDb.mockResolvedValue(undefined);
});

function makeCursor(toArrayResult: any[], nextResult?: any) {
  const c: any = {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(toArrayResult),
    next: vi.fn().mockResolvedValue(nextResult ?? null),
  };
  return c;
}

// ── List ────────────────────────────────────────────────────────────────────

describe("GET /dashboard/api/folders", () => {
  it("returns folders ordered by position, with stringified _id", async () => {
    const id1 = new ObjectId();
    const id2 = new ObjectId();
    const docs = [
      { _id: id1, name: "Plumbers", position: 0, createdAt: new Date(), updatedAt: new Date() },
      { _id: id2, name: "HVAC", position: 1, createdAt: new Date(), updatedAt: new Date() },
    ];
    mockFoldersFind.mockReturnValue(makeCursor(docs));
    const res = makeRes();
    await folders.listFoldersHandler(makeReq({}), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveLength(2);
    expect(res._json[0]._id).toBe(id1.toString());
    expect(res._json[0].name).toBe("Plumbers");
    expect(res._json[1].name).toBe("HVAC");
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

describe("POST /dashboard/api/folders", () => {
  it("400 when name is missing", async () => {
    const res = makeRes();
    await folders.createFolderHandler(makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("400 when name is whitespace", async () => {
    const res = makeRes();
    await folders.createFolderHandler(makeReq({ body: { name: "   " } }), res);
    expect(res._status).toBe(400);
  });

  it("creates folder with position = max + 1", async () => {
    const lastDoc = { _id: new ObjectId(), name: "X", position: 4, createdAt: new Date(), updatedAt: new Date() };
    mockFoldersFind.mockReturnValue(makeCursor([], lastDoc));
    const insertedId = new ObjectId();
    mockFoldersInsertOne.mockResolvedValue({ insertedId });
    mockFoldersFindOne.mockResolvedValue({
      _id: insertedId, name: "Plumbers", position: 5, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = makeRes();
    await folders.createFolderHandler(makeReq({ body: { name: "Plumbers" } }), res);
    expect(res._status).toBe(201);
    expect(res._json.name).toBe("Plumbers");
    expect(res._json.position).toBe(5);
    const insertedDoc = mockFoldersInsertOne.mock.calls[0][0];
    expect(insertedDoc.position).toBe(5);
    expect(insertedDoc.name).toBe("Plumbers");
  });

  it("creates folder with position 0 when none exist", async () => {
    mockFoldersFind.mockReturnValue(makeCursor([], null));
    const insertedId = new ObjectId();
    mockFoldersInsertOne.mockResolvedValue({ insertedId });
    mockFoldersFindOne.mockResolvedValue({
      _id: insertedId, name: "First", position: 0, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = makeRes();
    await folders.createFolderHandler(makeReq({ body: { name: "First" } }), res);
    expect(res._status).toBe(201);
    expect(res._json.position).toBe(0);
  });
});

// ── Update ──────────────────────────────────────────────────────────────────

describe("PATCH /dashboard/api/folders/:id", () => {
  it("400 on invalid id", async () => {
    const res = makeRes();
    await folders.updateFolderHandler(
      makeReq({ params: { id: "not-an-objectid" }, body: { name: "X" } }), res,
    );
    expect(res._status).toBe(400);
  });

  it("400 when no supported fields are provided", async () => {
    const res = makeRes();
    await folders.updateFolderHandler(
      makeReq({ params: { id: new ObjectId().toString() }, body: { foo: "bar" } }), res,
    );
    expect(res._status).toBe(400);
  });

  it("400 when name is empty string", async () => {
    const res = makeRes();
    await folders.updateFolderHandler(
      makeReq({ params: { id: new ObjectId().toString() }, body: { name: "  " } }), res,
    );
    expect(res._status).toBe(400);
  });

  it("404 when folder does not exist", async () => {
    mockFoldersFindOneAndUpdate.mockResolvedValue(null);
    const res = makeRes();
    await folders.updateFolderHandler(
      makeReq({ params: { id: new ObjectId().toString() }, body: { name: "X" } }), res,
    );
    expect(res._status).toBe(404);
  });

  it("renames folder and returns the updated doc", async () => {
    const id = new ObjectId();
    mockFoldersFindOneAndUpdate.mockResolvedValue({
      _id: id, name: "New Name", position: 2, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = makeRes();
    await folders.updateFolderHandler(
      makeReq({ params: { id: id.toString() }, body: { name: "New Name" } }), res,
    );
    expect(res._status).toBe(200);
    expect(res._json.name).toBe("New Name");
  });

  it("accepts numeric position update", async () => {
    const id = new ObjectId();
    mockFoldersFindOneAndUpdate.mockResolvedValue({
      _id: id, name: "X", position: 7, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = makeRes();
    await folders.updateFolderHandler(
      makeReq({ params: { id: id.toString() }, body: { position: 7 } }), res,
    );
    expect(res._status).toBe(200);
    expect(res._json.position).toBe(7);
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe("DELETE /dashboard/api/folders/:id", () => {
  it("400 on invalid id", async () => {
    const res = makeRes();
    await folders.deleteFolderHandler(makeReq({ params: { id: "bad" } }), res);
    expect(res._status).toBe(400);
  });

  it("404 when folder does not exist", async () => {
    mockClientsUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockFoldersDeleteOne.mockResolvedValue({ deletedCount: 0 });
    const res = makeRes();
    await folders.deleteFolderHandler(
      makeReq({ params: { id: new ObjectId().toString() } }), res,
    );
    expect(res._status).toBe(404);
  });

  it("clears folder_id on contained agents (does NOT delete them) then drops the folder", async () => {
    const id = new ObjectId();
    mockClientsUpdateMany.mockResolvedValue({ modifiedCount: 3 });
    mockFoldersDeleteOne.mockResolvedValue({ deletedCount: 1 });
    const res = makeRes();
    await folders.deleteFolderHandler(makeReq({ params: { id: id.toString() } }), res);
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.agents_unfiled).toBe(3);
    // Confirm clients.updateMany was called with $set folder_id = null
    expect(mockClientsUpdateMany).toHaveBeenCalledWith(
      { folder_id: id.toString() },
      { $set: { folder_id: null } },
    );
    // And the folder doc itself was deleted
    expect(mockFoldersDeleteOne).toHaveBeenCalled();
    // Cache refreshed
    expect(mockLoadClientsFromDb).toHaveBeenCalled();
  });
});

// ── Move agent to folder ────────────────────────────────────────────────────

describe("PATCH /dashboard/api/agents/:slug/folder", () => {
  it("404 when client not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await moveAgentFolder.moveAgentFolderHandler(
      makeReq({ params: { slug: "missing" }, body: { folder_id: null } }), res,
    );
    expect(res._status).toBe(404);
  });

  it("400 on malformed folder_id", async () => {
    mockGetClientDocument.mockResolvedValue({ _id: "acme" });
    const res = makeRes();
    await moveAgentFolder.moveAgentFolderHandler(
      makeReq({ params: { slug: "acme" }, body: { folder_id: "bogus" } }), res,
    );
    expect(res._status).toBe(400);
  });

  it("400 when folder_id refers to a non-existent folder", async () => {
    mockGetClientDocument.mockResolvedValue({ _id: "acme" });
    mockFoldersFindOne.mockResolvedValue(null);
    const res = makeRes();
    await moveAgentFolder.moveAgentFolderHandler(
      makeReq({ params: { slug: "acme" }, body: { folder_id: new ObjectId().toString() } }), res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/not found/);
  });

  it("moves to root when folder_id is null", async () => {
    mockGetClientDocument.mockResolvedValue({ _id: "acme" });
    mockUpdateClientFields.mockResolvedValue(undefined);
    const res = makeRes();
    await moveAgentFolder.moveAgentFolderHandler(
      makeReq({ params: { slug: "acme" }, body: { folder_id: null } }), res,
    );
    expect(res._status).toBe(200);
    expect(res._json.folder_id).toBeNull();
    expect(mockUpdateClientFields).toHaveBeenCalledWith("acme", { folder_id: null });
  });

  it("moves to a folder when folder_id refers to an existing folder", async () => {
    const folderId = new ObjectId();
    mockGetClientDocument.mockResolvedValue({ _id: "acme" });
    mockFoldersFindOne.mockResolvedValue({ _id: folderId, name: "Plumbers" });
    mockUpdateClientFields.mockResolvedValue(undefined);
    const res = makeRes();
    await moveAgentFolder.moveAgentFolderHandler(
      makeReq({ params: { slug: "acme" }, body: { folder_id: folderId.toString() } }), res,
    );
    expect(res._status).toBe(200);
    expect(res._json.folder_id).toBe(folderId.toString());
    expect(mockUpdateClientFields).toHaveBeenCalledWith("acme", { folder_id: folderId.toString() });
  });
});
