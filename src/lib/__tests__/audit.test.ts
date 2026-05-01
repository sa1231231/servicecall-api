import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInsertOne, mockCreateIndex } = vi.hoisted(() => ({
  mockInsertOne: vi.fn(),
  mockCreateIndex: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      insertOne: mockInsertOne,
      createIndex: mockCreateIndex,
    }),
  }),
}));

const { logAudit, ensureAuditIndex } = await import("../audit.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertOne.mockResolvedValue({});
  mockCreateIndex.mockResolvedValue("ix_audit");
});

function mockReq(overrides: Record<string, any> = {}) {
  return {
    user: { username: "alice", role: "admin" },
    ip: "10.0.0.1",
    ...overrides,
  } as any;
}

describe("logAudit", () => {
  it("inserts a record with username, role, action, target, ip, and timestamp", async () => {
    await logAudit(mockReq(), "delete_agent", "agent_abc", { reason: "test" });

    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    const entry = mockInsertOne.mock.calls[0][0];
    expect(entry).toMatchObject({
      username: "alice",
      role: "admin",
      action: "delete_agent",
      target: "agent_abc",
      details: { reason: "test" },
      ip: "10.0.0.1",
    });
    expect(entry.timestamp).toBeInstanceOf(Date);
  });

  it("falls back to 'unknown' when req.user is missing", async () => {
    await logAudit(mockReq({ user: undefined }), "action", "target");

    const entry = mockInsertOne.mock.calls[0][0];
    expect(entry.username).toBe("unknown");
    expect(entry.role).toBe("unknown");
  });

  it("falls back to 'unknown' for missing ip", async () => {
    await logAudit(mockReq({ ip: undefined }), "action", "target");

    const entry = mockInsertOne.mock.calls[0][0];
    expect(entry.ip).toBe("unknown");
  });

  it("omits details when not provided (stored as undefined)", async () => {
    await logAudit(mockReq(), "action", "target");

    const entry = mockInsertOne.mock.calls[0][0];
    expect(entry.details).toBeUndefined();
  });
});

describe("ensureAuditIndex", () => {
  it("creates a TTL index on timestamp at 90 days", async () => {
    await ensureAuditIndex();

    expect(mockCreateIndex).toHaveBeenCalledWith(
      { timestamp: 1 },
      { expireAfterSeconds: 90 * 86400 },
    );
  });
});
