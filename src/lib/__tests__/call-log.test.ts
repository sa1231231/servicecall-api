import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CallLogDocument } from "../call-log.js";

const { mockReplaceOne, mockUpdateOne, mockFindOne, mockFind } = vi.hoisted(() => ({
  mockReplaceOne: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockFindOne: vi.fn(),
  mockFind: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      replaceOne: mockReplaceOne,
      updateOne: mockUpdateOne,
      findOne: mockFindOne,
      find: mockFind,
    }),
  }),
}));

const { saveCallLog, enrichCallLog, getCallLogById, getCallLogsByClient } = await import("../call-log.js");

function makeDoc(overrides: Partial<CallLogDocument> = {}): CallLogDocument {
  return {
    _id: "call_123",
    client_slug: "acme",
    client_name: "Acme",
    agent_id: "agent_x",
    from_number: "+15550001111",
    duration_ms: 30000,
    disconnection_reason: "user_hangup",
    all_variables: {},
    extracted_fields: {},
    message_type_key: "default",
    message_type_label: "Default",
    outcome: "dispatched",
    shadow_mode: false,
    created_at: new Date(),
    ...overrides,
  };
}

function chainableFind(items: any[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(items),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveCallLog", () => {
  it("upserts via replaceOne keyed by _id", async () => {
    mockReplaceOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });
    const doc = makeDoc({ _id: "call_abc" });

    await saveCallLog(doc);

    expect(mockReplaceOne).toHaveBeenCalledWith(
      { _id: "call_abc" },
      doc,
      { upsert: true },
    );
  });

  it("swallows errors (fire-and-forget)", async () => {
    mockReplaceOne.mockRejectedValue(new Error("conn lost"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(saveCallLog(makeDoc())).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("failed to save call"),
      "conn lost",
    );
    err.mockRestore();
  });
});

describe("enrichCallLog", () => {
  it("filters undefined/null values before $set", async () => {
    mockUpdateOne.mockResolvedValue({});
    await enrichCallLog("call_x", {
      call_summary: "ok",
      user_sentiment: undefined,
      transcript: "hello",
      recording_url: undefined,
    });

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "call_x" },
      { $set: { call_summary: "ok", transcript: "hello" } },
    );
  });

  it("no-ops when there's nothing to set", async () => {
    await enrichCallLog("call_x", {
      call_summary: undefined,
      user_sentiment: undefined,
    });

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("swallows errors", async () => {
    mockUpdateOne.mockRejectedValue(new Error("nope"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(enrichCallLog("c", { call_summary: "x" })).resolves.toBeUndefined();
    err.mockRestore();
  });
});

describe("getCallLogById", () => {
  it("looks up by _id", async () => {
    const doc = makeDoc({ _id: "call_id_1" });
    mockFindOne.mockResolvedValue(doc);

    const result = await getCallLogById("call_id_1");

    expect(mockFindOne).toHaveBeenCalledWith({ _id: "call_id_1" });
    expect(result).toBe(doc);
  });

  it("returns null when not found", async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await getCallLogById("missing")).toBeNull();
  });
});

describe("getCallLogsByClient", () => {
  it("queries by client_slug, sorted newest first, with default limit/offset", async () => {
    const docs = [makeDoc({ _id: "c1" }), makeDoc({ _id: "c2" })];
    const cursor = chainableFind(docs);
    mockFind.mockReturnValue(cursor);

    const result = await getCallLogsByClient("acme");

    expect(mockFind).toHaveBeenCalledWith({ client_slug: "acme", test_mode: { $ne: true } });
    expect(cursor.sort).toHaveBeenCalledWith({ created_at: -1 });
    expect(cursor.skip).toHaveBeenCalledWith(0);
    expect(cursor.limit).toHaveBeenCalledWith(50);
    expect(result).toBe(docs);
  });

  it("includes test_mode entries when includeTests=true", async () => {
    const cursor = chainableFind([]);
    mockFind.mockReturnValue(cursor);

    await getCallLogsByClient("acme", 50, 0, { includeTests: true });

    expect(mockFind).toHaveBeenCalledWith({ client_slug: "acme" });
  });

  it("respects custom limit and offset", async () => {
    const cursor = chainableFind([]);
    mockFind.mockReturnValue(cursor);

    await getCallLogsByClient("acme", 10, 20);

    expect(cursor.skip).toHaveBeenCalledWith(20);
    expect(cursor.limit).toHaveBeenCalledWith(10);
  });
});
