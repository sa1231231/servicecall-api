// Coverage for the finding-rates aggregation lib (src/lib/finding-rates.ts).
// Mocks getDb so the lib's two parallel find() calls route to per-collection
// stubs we can program per test. Time is anchored via the `now` parameter
// (test seam) instead of vi.useFakeTimers — easier to reason about, and
// the lib's only Date.now usage is the one we already inject.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCollection } = vi.hoisted(() => ({
  mockCollection: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({ collection: (name: string) => mockCollection(name) }),
}));

const { getFindingRateMetrics, FINDING_TYPES } = await import("../finding-rates.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

interface Row { created_at: Date; type?: string; }

/** Wire the mocked db.collection() so calls to "call_logs" return `calls`
 *  and calls to "call_findings" return `findings`. */
function seed(calls: Row[], findings: Row[]) {
  mockCollection.mockImplementation((name: string) => {
    const data = name === "call_logs" ? calls : name === "call_findings" ? findings : [];
    return {
      find: () => ({ toArray: async () => data }),
    };
  });
}

/** Always anchored at the same hour-of-day so bucket boundaries are stable. */
const NOW = new Date("2026-05-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mockCollection.mockReset();
});

// ── Schema/shape ────────────────────────────────────────────────────────────

describe("getFindingRateMetrics — shape", () => {
  it("returns one bucket per requested week and zeros for empty types", async () => {
    seed([], []);
    const m = await getFindingRateMetrics("agent_1", 4, NOW);
    expect(m.weeks).toBe(4);
    expect(m.buckets).toHaveLength(4);
    for (const b of m.buckets) {
      expect(b.calls).toBe(0);
      // Every FindingType key present even with no data, so the UI never
      // has to handle "missing key" cases.
      for (const t of FINDING_TYPES) expect(b.by_type[t]).toBe(0);
    }
    expect(m.totals.calls).toBe(0);
  });

  it("clamps `weeks` between 1 and 12", async () => {
    seed([], []);
    expect((await getFindingRateMetrics("a", 0, NOW)).weeks).toBe(1);
    expect((await getFindingRateMetrics("a", 99, NOW)).weeks).toBe(12);
  });

  it("buckets are oldest → newest with contiguous week_start/week_end", async () => {
    seed([], []);
    const m = await getFindingRateMetrics("a", 3, NOW);
    for (let i = 1; i < m.buckets.length; i++) {
      expect(m.buckets[i].week_start).toBe(m.buckets[i - 1].week_end);
    }
  });
});

// ── Counting ────────────────────────────────────────────────────────────────

describe("getFindingRateMetrics — counting", () => {
  it("places calls and findings into the right week bucket", async () => {
    // Latest bucket starts at NOW floored to UTC midnight + 1 day - 7 days.
    // Easier: use timestamps relative to NOW. A row 1 day before NOW is in
    // the latest bucket; 8 days before NOW is the previous bucket; etc.
    const recent = new Date(NOW.getTime() - 1 * DAY);
    const lastWeek = new Date(NOW.getTime() - 8 * DAY);
    const twoWksAgo = new Date(NOW.getTime() - 15 * DAY);

    seed(
      [
        { created_at: recent },
        { created_at: recent },
        { created_at: lastWeek },
        { created_at: twoWksAgo },
      ],
      [
        { created_at: recent, type: "unanswered_question" },
        { created_at: recent, type: "unanswered_question" },
        { created_at: lastWeek, type: "misheard_confirmation" },
        { created_at: twoWksAgo, type: "path_misroute" },
      ],
    );

    const m = await getFindingRateMetrics("agent_1", 4, NOW);
    const latest = m.buckets[3];
    const prior = m.buckets[2];
    const twoBack = m.buckets[1];

    expect(latest.calls).toBe(2);
    expect(latest.by_type.unanswered_question).toBe(2);
    expect(prior.calls).toBe(1);
    expect(prior.by_type.misheard_confirmation).toBe(1);
    expect(twoBack.calls).toBe(1);
    expect(twoBack.by_type.path_misroute).toBe(1);

    expect(m.totals.calls).toBe(4);
    expect(m.totals.by_type.unanswered_question).toBe(2);
    expect(m.totals.by_type.misheard_confirmation).toBe(1);
    expect(m.totals.by_type.path_misroute).toBe(1);
  });

  it("ignores findings older than the window", async () => {
    const longAgo = new Date(NOW.getTime() - 90 * DAY);
    seed([], [{ created_at: longAgo, type: "unanswered_question" }]);
    const m = await getFindingRateMetrics("agent_1", 4, NOW);
    expect(m.totals.by_type.unanswered_question).toBe(0);
  });

  it("ignores findings with an unknown type (forward-compat with future enum additions)", async () => {
    const recent = new Date(NOW.getTime() - 1 * DAY);
    seed([], [{ created_at: recent, type: "totally_new_type_added_later" }]);
    const m = await getFindingRateMetrics("agent_1", 4, NOW);
    expect(m.totals.by_type.unanswered_question).toBe(0);
    // None of the known types should have been incremented.
    for (const t of FINDING_TYPES) expect(m.totals.by_type[t]).toBe(0);
  });
});
