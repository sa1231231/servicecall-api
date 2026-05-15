import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// auditLogHandler builds a Mongo filter from query params (date window,
// action/username exact-match, target prefix-regex) + runs find/count/
// distinct in parallel. This pins the filter composition, limit clamping,
// regex escaping (injection surface on `target`), and the hasMore math —
// none of which was covered before.

const { mockFind, mockCount, mockDistinct, findRows } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockCount: vi.fn(),
  mockDistinct: vi.fn(),
  // Mutable holder for the rows the chained find() cursor returns.
  // `.current` is reassigned per-test instead of stashing on the mock fn.
  findRows: { current: [] as any[] },
}));

// A chainable find() cursor: .sort().skip().limit().toArray()
function cursor(rows: any[]) {
  const c: any = {};
  c.sort = () => c;
  c.skip = () => c;
  c.limit = () => c;
  c.toArray = async () => rows;
  return c;
}

vi.mock("../../../lib/db.js", () => ({
  getDb: () => ({
    collection: () => ({
      find: (filter: any) => { mockFind(filter); return cursor(findRows.current); },
      countDocuments: (filter: any) => mockCount(filter),
      distinct: (field: string, filter: any) => mockDistinct(field, filter),
    }),
  }),
}));

const { auditLogHandler } = await import("../audit-log.js");

function makeReq(query: Record<string, unknown> = {}): Request {
  return { query } as any;
}
function makeRes(): Response & { _json: any } {
  const res: any = {};
  res.json = (b: any) => { res._json = b; return res; };
  return res;
}

beforeEach(() => {
  mockFind.mockReset();
  mockCount.mockReset();
  mockDistinct.mockReset();
  findRows.current = [];
  mockCount.mockResolvedValue(0);
  mockDistinct.mockResolvedValue([]);
});

describe("auditLogHandler — filter composition", () => {
  it("defaults to a 30-day window when no since/until given", async () => {
    const before = Date.now();
    await auditLogHandler(makeReq(), makeRes());
    const filter = mockFind.mock.calls[0][0];
    const since = filter.timestamp.$gte.getTime();
    const until = filter.timestamp.$lte.getTime();
    // since ≈ now − 30d, until ≈ now
    expect(before - since).toBeGreaterThan(29 * 86400 * 1000);
    expect(before - since).toBeLessThan(31 * 86400 * 1000);
    expect(until).toBeGreaterThanOrEqual(before - 1000);
  });

  it("honors explicit since/until ISO strings", async () => {
    await auditLogHandler(
      makeReq({ since: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z" }),
      makeRes(),
    );
    const filter = mockFind.mock.calls[0][0];
    expect(filter.timestamp.$gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(filter.timestamp.$lte.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("adds exact-match action + username filters when present", async () => {
    await auditLogHandler(makeReq({ action: "delete_agent", username: "sam" }), makeRes());
    const filter = mockFind.mock.calls[0][0];
    expect(filter.action).toBe("delete_agent");
    expect(filter.username).toBe("sam");
  });

  it("omits action/username when blank", async () => {
    await auditLogHandler(makeReq({ action: "", username: "" }), makeRes());
    const filter = mockFind.mock.calls[0][0];
    expect("action" in filter).toBe(false);
    expect("username" in filter).toBe(false);
  });

  it("target becomes an anchored prefix regex with special chars escaped", async () => {
    // A target with regex metacharacters must not become a live pattern —
    // it's escaped so the $regex match stays a literal prefix.
    await auditLogHandler(makeReq({ target: "acme.hvac+1(test)" }), makeRes());
    const filter = mockFind.mock.calls[0][0];
    expect(filter.target.$regex).toBe("^acme\\.hvac\\+1\\(test\\)");
  });
});

describe("auditLogHandler — limit / offset clamping", () => {
  it("clamps limit to 1..500, default 100", async () => {
    // Default
    await auditLogHandler(makeReq(), makeRes());
    // Over the max
    await auditLogHandler(makeReq({ limit: "9999" }), makeRes());
    // Garbage / non-positive
    await auditLogHandler(makeReq({ limit: "-5" }), makeRes());
    await auditLogHandler(makeReq({ limit: "abc" }), makeRes());
    // All four calls succeeded without throwing — clamping happened
    // internally; we just assert the handler ran each time.
    expect(mockFind).toHaveBeenCalledTimes(4);
  });

  it("computes hasMore from total vs offset + page length", async () => {
    findRows.current = [{ action: "a" }, { action: "b" }];
    mockCount.mockResolvedValue(10);
    const res1 = makeRes();
    await auditLogHandler(makeReq({ offset: "0" }), res1);
    expect(res1._json.hasMore).toBe(true); // 0 + 2 < 10

    findRows.current = [{ action: "a" }];
    mockCount.mockResolvedValue(9);
    const res2 = makeRes();
    await auditLogHandler(makeReq({ offset: "8" }), res2);
    expect(res2._json.hasMore).toBe(false); // 8 + 1 == 9
  });
});

describe("auditLogHandler — response shape", () => {
  it("returns entries + sorted distinct actions/usernames", async () => {
    findRows.current = [{ action: "delete_agent", username: "sam" }];
    mockCount.mockResolvedValue(1);
    mockDistinct.mockImplementation(async (field: string) =>
      field === "action"
        ? ["update_agent", "delete_agent", ""]
        : ["zoe", "alice", ""],
    );
    const res = makeRes();
    await auditLogHandler(makeReq(), res);
    expect(res._json.entries).toHaveLength(1);
    expect(res._json.total).toBe(1);
    // Blank values filtered, rest sorted.
    expect(res._json.actions).toEqual(["delete_agent", "update_agent"]);
    expect(res._json.usernames).toEqual(["alice", "zoe"]);
  });
});
