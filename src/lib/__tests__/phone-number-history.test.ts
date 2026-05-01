import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInsertOne, mockFindOne, mockFind } = vi.hoisted(() => ({
  mockInsertOne: vi.fn(),
  mockFindOne: vi.fn(),
  mockFind: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      insertOne: mockInsertOne,
      findOne: mockFindOne,
      find: mockFind,
    }),
  }),
}));

const { logPhoneEvent, getNumberDaysInRange, backfillCurrentPhoneNumbers } = await import("../phone-number-history.js");

function chainableFind(items: any[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(items),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const MS_PER_DAY = 86_400_000;
const D = (iso: string) => new Date(iso);

describe("logPhoneEvent", () => {
  it("inserts a doc with all fields and a default timestamp", async () => {
    mockInsertOne.mockResolvedValue({});
    const before = Date.now();

    await logPhoneEvent("acme", "+15550001111", "PN_test", "provisioned");

    const doc = mockInsertOne.mock.calls[0][0];
    expect(doc).toMatchObject({
      client_slug: "acme",
      phone_number: "+15550001111",
      phone_number_sid: "PN_test",
      event: "provisioned",
    });
    expect(doc.at).toBeInstanceOf(Date);
    expect(doc.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("uses the provided `at` date when given", async () => {
    mockInsertOne.mockResolvedValue({});
    const at = D("2026-01-15T12:00:00Z");

    await logPhoneEvent("acme", "+15550001111", "PN_test", "released", at);

    expect(mockInsertOne.mock.calls[0][0].at).toBe(at);
  });

  it("swallows insert errors (fire-and-forget)", async () => {
    mockInsertOne.mockRejectedValue(new Error("conn lost"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      logPhoneEvent("acme", "+15550001111", "PN", "provisioned"),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("failed to log provisioned"),
      "conn lost",
    );
    err.mockRestore();
  });
});

describe("getNumberDaysInRange", () => {
  it("returns 0 when there are no events for the client", async () => {
    mockFind.mockReturnValue(chainableFind([]));
    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );
    expect(days).toBe(0);
  });

  it("counts a number active for the entire range as the full window length", async () => {
    // provisioned 30 days before window start, never released → entire 31-day Jan window active.
    mockFind.mockReturnValue(chainableFind([
      { phone_number: "+15550001111", event: "provisioned", at: D("2025-12-01T00:00:00Z") },
    ]));

    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );

    expect(days).toBeCloseTo(31, 6);
  });

  it("counts a partial window when the number is provisioned mid-range", async () => {
    mockFind.mockReturnValue(chainableFind([
      { phone_number: "+15550001111", event: "provisioned", at: D("2026-01-15T00:00:00Z") },
    ]));

    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );

    // 15th to Feb 1 = 17 days
    expect(days).toBeCloseTo(17, 6);
  });

  it("clips at the released event when present in-range", async () => {
    mockFind.mockReturnValue(chainableFind([
      { phone_number: "+15550001111", event: "provisioned", at: D("2026-01-01T00:00:00Z") },
      { phone_number: "+15550001111", event: "released",    at: D("2026-01-11T00:00:00Z") },
    ]));

    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );

    expect(days).toBeCloseTo(10, 6);
  });

  it("returns 0 when the active window doesn't intersect the query range", async () => {
    mockFind.mockReturnValue(chainableFind([
      { phone_number: "+15550001111", event: "provisioned", at: D("2025-11-01T00:00:00Z") },
      { phone_number: "+15550001111", event: "released",    at: D("2025-11-15T00:00:00Z") },
    ]));

    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );

    expect(days).toBe(0);
  });

  it("sums across multiple distinct phone numbers", async () => {
    mockFind.mockReturnValue(chainableFind([
      // Number A: active 10 days
      { phone_number: "+15550001111", event: "provisioned", at: D("2026-01-01T00:00:00Z") },
      { phone_number: "+15550001111", event: "released",    at: D("2026-01-11T00:00:00Z") },
      // Number B: active 5 days
      { phone_number: "+15550002222", event: "provisioned", at: D("2026-01-20T00:00:00Z") },
      { phone_number: "+15550002222", event: "released",    at: D("2026-01-25T00:00:00Z") },
    ]));

    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );

    expect(days).toBeCloseTo(15, 6);
  });

  it("handles a number that was provisioned and released and re-provisioned", async () => {
    mockFind.mockReturnValue(chainableFind([
      { phone_number: "+15550001111", event: "provisioned", at: D("2026-01-01T00:00:00Z") },
      { phone_number: "+15550001111", event: "released",    at: D("2026-01-06T00:00:00Z") },
      { phone_number: "+15550001111", event: "provisioned", at: D("2026-01-20T00:00:00Z") },
      // still active at end of window
    ]));

    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );

    // 5 days (1-6) + 12 days (20 → Feb 1) = 17
    expect(days).toBeCloseTo(17, 6);
  });

  it("ignores duplicate provisioned events on the same number (no double-count)", async () => {
    mockFind.mockReturnValue(chainableFind([
      { phone_number: "+15550001111", event: "provisioned", at: D("2026-01-01T00:00:00Z") },
      { phone_number: "+15550001111", event: "provisioned", at: D("2026-01-15T00:00:00Z") },
    ]));

    const days = await getNumberDaysInRange(
      "acme",
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );

    // Should still be 31 days since the second `provisioned` is ignored while active.
    expect(days).toBeCloseTo(31, 6);
  });
});

describe("backfillCurrentPhoneNumbers", () => {
  it("inserts a synthetic provisioned event when none exists", async () => {
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({});

    const at = D("2026-05-01T00:00:00Z");
    const written = await backfillCurrentPhoneNumbers(
      [{ client_slug: "acme", phone_number: "+15550001111", phone_number_sid: "PN_a" }],
      at,
    );

    expect(written).toBe(1);
    expect(mockInsertOne).toHaveBeenCalledWith({
      client_slug: "acme",
      phone_number: "+15550001111",
      phone_number_sid: "PN_a",
      event: "provisioned",
      at,
    });
  });

  it("skips clients whose number already has a provisioned event", async () => {
    mockFindOne.mockResolvedValue({ _id: "existing" });

    const written = await backfillCurrentPhoneNumbers([
      { client_slug: "acme", phone_number: "+15550001111", phone_number_sid: "PN_a" },
    ]);

    expect(written).toBe(0);
    expect(mockInsertOne).not.toHaveBeenCalled();
  });

  it("skips clients with empty phone_number", async () => {
    const written = await backfillCurrentPhoneNumbers([
      { client_slug: "acme", phone_number: "", phone_number_sid: "" },
    ]);

    expect(written).toBe(0);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockInsertOne).not.toHaveBeenCalled();
  });

  it("defaults phone_number_sid to empty string when missing", async () => {
    mockFindOne.mockResolvedValue(null);
    mockInsertOne.mockResolvedValue({});

    await backfillCurrentPhoneNumbers([
      { client_slug: "acme", phone_number: "+15550001111" },
    ]);

    expect(mockInsertOne.mock.calls[0][0].phone_number_sid).toBe("");
  });

  it("processes multiple clients independently", async () => {
    mockFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "exists" })
      .mockResolvedValueOnce(null);
    mockInsertOne.mockResolvedValue({});

    const written = await backfillCurrentPhoneNumbers([
      { client_slug: "a", phone_number: "+15551111111", phone_number_sid: "PN_a" },
      { client_slug: "b", phone_number: "+15552222222", phone_number_sid: "PN_b" },
      { client_slug: "c", phone_number: "+15553333333", phone_number_sid: "PN_c" },
    ]);

    expect(written).toBe(2);
    expect(mockInsertOne).toHaveBeenCalledTimes(2);
  });

  it("returns 0 for empty input", async () => {
    const written = await backfillCurrentPhoneNumbers([]);
    expect(written).toBe(0);
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});
