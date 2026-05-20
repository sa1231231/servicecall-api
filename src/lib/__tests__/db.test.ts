import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConnect, mockDb, mockOn, handlers } = vi.hoisted(() => {
  const handlers: Record<string, (event: unknown) => void> = {};
  return {
    mockConnect: vi.fn(),
    mockDb: vi.fn(),
    // Capture the heartbeat handlers initDb registers so tests can invoke
    // them directly to exercise the outage watchdog.
    mockOn: vi.fn((event: string, h: (e: unknown) => void) => { handlers[event] = h; }),
    handlers,
  };
});

vi.mock("../../config.js", () => ({
  config: { MONGODB_URL: "mongodb://test/db" },
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    connect = mockConnect;
    db = mockDb;
    on = mockOn;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const k of Object.keys(handlers)) delete handlers[k];
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

describe("MongoDB outage watchdog", () => {
  it("does not exit on a single heartbeat failure (still within threshold)", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockDb.mockReturnValue({ name: "fake" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);

    const { initDb } = await import("../db.js");
    await initDb();

    // One failure right after a successful connect — well under the 60 s
    // threshold, so the watchdog should NOT exit.
    handlers["serverHeartbeatFailed"]?.({ failure: { message: "EAI_AGAIN" } });

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("exits when mongo heartbeats fail past the outage threshold", async () => {
    vi.useFakeTimers();
    try {
      mockConnect.mockResolvedValue(undefined);
      mockDb.mockReturnValue({ name: "fake" });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);

      const { initDb } = await import("../db.js");
      await initDb();

      // Push the clock 61 s past the initial success, then fire a failure.
      // The watchdog compares now → lastHeartbeatSuccessAt; the gap exceeds
      // MONGO_OUTAGE_THRESHOLD_MS (60 s) so it must call process.exit(1).
      vi.setSystemTime(Date.now() + 61_000);
      handlers["serverHeartbeatFailed"]?.({ failure: { message: "EAI_AGAIN" } });

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the outage timer on a heartbeat success", async () => {
    vi.useFakeTimers();
    try {
      mockConnect.mockResolvedValue(undefined);
      mockDb.mockReturnValue({ name: "fake" });
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);

      const { initDb } = await import("../db.js");
      await initDb();

      // 30 s in, a heartbeat succeeds — that resets the deadline.
      vi.setSystemTime(Date.now() + 30_000);
      handlers["serverHeartbeatSucceeded"]?.({});
      // Another 50 s later (80 s from initial success, only 50 s since the
      // last success) — still under threshold, must NOT exit.
      vi.setSystemTime(Date.now() + 50_000);
      handlers["serverHeartbeatFailed"]?.({ failure: { message: "EAI_AGAIN" } });

      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
