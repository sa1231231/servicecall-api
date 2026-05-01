import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetSettings, mockGetNumberDaysInRange, mockAggregate, mockFind } = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockGetNumberDaysInRange: vi.fn(),
  mockAggregate: vi.fn(),
  mockFind: vi.fn(),
}));

vi.mock("../settings.js", () => ({
  getSettings: (...a: any[]) => mockGetSettings(...a),
}));

vi.mock("../phone-number-history.js", () => ({
  getNumberDaysInRange: (...a: any[]) => mockGetNumberDaysInRange(...a),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      aggregate: (...a: any[]) => ({ toArray: () => mockAggregate(...a) }),
      find: (...a: any[]) => mockFind(...a),
    }),
  }),
}));

const { getClientCogs, getMtdCogsForAllClients } = await import("../billing-cogs.js");

const RATES = {
  twilio_sms_cents: 0.79,
  resend_email_cents: 0.04,
  twilio_number_monthly_cents: 115,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockGetSettings.mockResolvedValue({ cost_rates: RATES });
  mockGetNumberDaysInRange.mockResolvedValue(0);
  mockAggregate.mockResolvedValue([]);
  mockFind.mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue([]),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getClientCogs", () => {
  it("returns the current month + last 6 history months by default", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));

    const result = await getClientCogs("acme");

    expect(result.client_slug).toBe("acme");
    expect(result.rates).toEqual(RATES);
    expect(result.current.month).toBe("2026-05");
    expect(result.current.is_partial).toBe(true);
    expect(result.history).toHaveLength(6);
    expect(result.history[0].month).toBe("2026-04");
    expect(result.history[5].month).toBe("2025-11");
    for (const h of result.history) {
      expect(h.is_partial).toBe(false);
    }
  });

  it("supports a custom monthsBack count", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));

    const result = await getClientCogs("acme", 2);

    expect(result.history).toHaveLength(2);
    expect(result.history.map((h) => h.month)).toEqual(["2026-04", "2026-03"]);
  });

  it("aggregates retell + sms + email + phone costs into total_cents", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));

    // Current month: 5000 cents retell, 100 SMS, 50 emails
    mockAggregate.mockResolvedValue([
      { _id: null, retell_cents: 5000, sms_count: 100, email_count: 50 },
    ]);
    // 10 days of phone-number activity in May (31-day month)
    mockGetNumberDaysInRange.mockResolvedValue(10);

    const result = await getClientCogs("acme", 0);

    const c = result.current;
    expect(c.retell_cents).toBe(5000);
    expect(c.sms_count).toBe(100);
    expect(c.email_count).toBe(50);
    // sms = round(100 * 0.79) = 79
    expect(c.sms_cents).toBe(79);
    // email = round(50 * 0.04) = 2
    expect(c.email_cents).toBe(2);
    // phone = round(10 * 115/31) = round(37.0967...) = 37
    expect(c.phone_cents).toBe(37);
    expect(c.phone_number_days).toBeCloseTo(10, 6);
    // total = 5000 + 79 + 2 + 37 = 5118
    expect(c.total_cents).toBe(5118);
  });

  it("returns zeroed bucket when no calls and no phone activity", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));

    const result = await getClientCogs("acme", 0);

    const c = result.current;
    expect(c.retell_cents).toBe(0);
    expect(c.sms_count).toBe(0);
    expect(c.sms_cents).toBe(0);
    expect(c.email_count).toBe(0);
    expect(c.email_cents).toBe(0);
    expect(c.phone_cents).toBe(0);
    expect(c.total_cents).toBe(0);
  });

  it("crosses year boundaries when looking back from January", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));

    const result = await getClientCogs("acme", 3);

    expect(result.current.month).toBe("2026-01");
    expect(result.history.map((h) => h.month)).toEqual(["2025-12", "2025-11", "2025-10"]);
  });

  it("queries call_logs scoped to the right month window", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));

    await getClientCogs("acme", 0);

    // First aggregate call should be for May 2026.
    const pipeline = mockAggregate.mock.calls[0][0];
    const matchStage = pipeline.find((s: any) => s.$match);
    expect(matchStage.$match.client_slug).toBe("acme");
    expect(matchStage.$match.created_at.$gte).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(matchStage.$match.created_at.$lt).toBeInstanceOf(Date);
  });

  it("uses month-end (not now) for the $lt of historical months", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));

    await getClientCogs("acme", 1);

    // Second aggregate call (history[0] = April 2026) should match Apr 1 → May 1.
    const pipeline = mockAggregate.mock.calls[1][0];
    const matchStage = pipeline.find((s: any) => s.$match);
    expect(matchStage.$match.created_at.$gte).toEqual(new Date(Date.UTC(2026, 3, 1)));
    expect(matchStage.$match.created_at.$lt).toEqual(new Date(Date.UTC(2026, 4, 1)));
  });
});

describe("getMtdCogsForAllClients", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  it("returns empty when no calls and no phone events", async () => {
    const result = await getMtdCogsForAllClients();
    expect(result).toEqual({});
  });

  it("sums retell + sms + email + phone for each client", async () => {
    mockAggregate.mockResolvedValue([
      { _id: "acme", retell_cents: 1000, sms_count: 10, email_count: 5 },
      { _id: "beta", retell_cents: 200,  sms_count: 0,  email_count: 0 },
    ]);

    // Number provisioned mid-May for "acme" only.
    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([
        {
          client_slug: "acme",
          phone_number: "+15550001111",
          event: "provisioned",
          at: new Date("2026-05-05T00:00:00Z"),
        },
      ]),
    });

    const result = await getMtdCogsForAllClients();

    // acme: retell 1000 + sms round(10 * 0.79)=8 + email round(5 * 0.04)=0
    // + phone: provisioned May 5 00:00, "now" = May 15 12:00 → 10.5 days * (115/31)
    //   = round(38.95) = 39
    // = 1047
    expect(result.acme).toBe(1000 + 8 + 0 + 39);

    // beta: 200 only
    expect(result.beta).toBe(200);
  });

  it("includes clients that have phone activity but no calls", async () => {
    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([
        {
          client_slug: "phone-only",
          phone_number: "+15550009999",
          event: "provisioned",
          at: new Date("2026-05-01T00:00:00Z"),
        },
      ]),
    });

    const result = await getMtdCogsForAllClients();

    expect(result["phone-only"]).toBeGreaterThan(0);
  });

  it("clips active phone-number windows to the current month start", async () => {
    // Provisioned long before May → should only count May 1 → now (≈14.5 days at fake time of May 15 noon)
    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([
        {
          client_slug: "old-client",
          phone_number: "+15550001111",
          event: "provisioned",
          at: new Date("2025-01-01T00:00:00Z"),
        },
      ]),
    });

    const result = await getMtdCogsForAllClients();

    // Exact value depends on rounding; should be roughly round(14.5 * 115/31) ≈ 54
    expect(result["old-client"]).toBeGreaterThanOrEqual(53);
    expect(result["old-client"]).toBeLessThanOrEqual(55);
  });

  it("ignores released numbers after release date", async () => {
    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([
        {
          client_slug: "released-client",
          phone_number: "+15550001111",
          event: "provisioned",
          at: new Date("2026-05-01T00:00:00Z"),
        },
        {
          client_slug: "released-client",
          phone_number: "+15550001111",
          event: "released",
          at: new Date("2026-05-06T00:00:00Z"),
        },
      ]),
    });

    const result = await getMtdCogsForAllClients();

    // 5 days * 115/31 ≈ 18.55 → 19
    expect(result["released-client"]).toBe(19);
  });

  it("handles re-provisioning (release + re-provision in same month)", async () => {
    mockFind.mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([
        {
          client_slug: "reprov",
          phone_number: "+15550001111",
          event: "provisioned",
          at: new Date("2026-05-01T00:00:00Z"),
        },
        {
          client_slug: "reprov",
          phone_number: "+15550001111",
          event: "released",
          at: new Date("2026-05-04T00:00:00Z"),
        },
        {
          client_slug: "reprov",
          phone_number: "+15550001111",
          event: "provisioned",
          at: new Date("2026-05-10T00:00:00Z"),
        },
      ]),
    });

    const result = await getMtdCogsForAllClients();

    // 3 days (1-4) + 5.5 days (10 → May 15 12:00) = 8.5 days * 115/31 ≈ 31.53 → 32
    expect(result.reprov).toBeGreaterThanOrEqual(30);
    expect(result.reprov).toBeLessThanOrEqual(33);
  });
});
