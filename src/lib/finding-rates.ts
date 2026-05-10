// Outcome metric for the self-optimizing suggestions pipeline. Answers the
// question: "Are the suggestions I've been approving actually reducing the
// problems they targeted?" — by tracking findings-per-completed-call per
// FindingType per week, per agent.
//
// Read by GET /agents/:slug/finding-rates and rendered as a header tile +
// per-suggestion-card sparkline in the dashboard suggestions tab.
//
// TTL note: call_findings has a 90-day TTL, so we cap weeks at 12. call_logs
// has no TTL, so the denominator (completed-call counts) is reliable
// arbitrarily far back.

import { getDb } from "./db.js";
import type { FindingType } from "./call-findings.js";

// All 6 finding types — kept in sync with FindingType in call-findings.ts.
// Listed explicitly so empty buckets render with `0` for every type instead
// of a sparse object that would make the UI handle "missing" specially.
export const FINDING_TYPES: readonly FindingType[] = [
  "unanswered_question",
  "misheard_confirmation",
  "repeated_data",
  "frustration_signal",
  "premature_termination",
  "path_misroute",
] as const;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 90-day TTL on call_findings means anything beyond ~12 weeks is empty by
// construction. Hard-cap so the UI can't ask for noise.
const MAX_WEEKS = 12;
// Calls shorter than this are voicemail/hangups/wrong-numbers — they don't
// produce findings either way, so excluding them keeps the rate honest.
const MIN_DURATION_MS = 30_000;
// Outcomes that aren't real customer interactions and should be excluded
// from the denominator. shadow_dry_run is excluded too (no real customer).
const NON_CALL_OUTCOMES = new Set(["web_call", "test_call", "shadow_dry_run"]);

export interface WeekBucket {
  /** ISO date for the start of the week (UTC midnight). */
  week_start: string;
  /** ISO date one week later. */
  week_end: string;
  /** Completed calls (duration ≥ 30s, excluding test/web/shadow). */
  calls: number;
  /** Finding count per FindingType in this week. Always all 6 keys. */
  by_type: Record<FindingType, number>;
}

export interface FindingRateMetrics {
  agent_id: string;
  weeks: number;
  /** ISO date for the start of the oldest week in `buckets`. */
  window_start: string;
  /** Oldest → newest. Length === weeks. */
  buckets: WeekBucket[];
  /** Sums across the whole window. */
  totals: {
    calls: number;
    by_type: Record<FindingType, number>;
  };
}

export async function getFindingRateMetrics(
  agentId: string,
  weeksRequested = 8,
  /** Test seam — defaults to "now" floored to UTC midnight. */
  now: Date = new Date(),
): Promise<FindingRateMetrics> {
  const weeks = Math.max(1, Math.min(weeksRequested, MAX_WEEKS));

  // Anchor the window at UTC midnight today + one day, so the latest bucket
  // covers an open week ending now. Aligning to UTC keeps weeks stable
  // across timezones and DST shifts.
  const endAnchor = floorUtcDay(now);
  endAnchor.setUTCDate(endAnchor.getUTCDate() + 1);
  const windowEnd = endAnchor;
  const windowStart = new Date(windowEnd.getTime() - weeks * WEEK_MS);

  const db = getDb();

  // Pull the two streams in parallel — they're independent.
  const [callRows, findingRows] = await Promise.all([
    db.collection("call_logs")
      .find(
        {
          agent_id: agentId,
          created_at: { $gte: windowStart, $lt: windowEnd },
          duration_ms: { $gte: MIN_DURATION_MS },
          outcome: { $nin: [...NON_CALL_OUTCOMES] },
          test_mode: { $ne: true },
        },
        { projection: { created_at: 1 } },
      )
      .toArray(),
    db.collection("call_findings")
      .find(
        {
          agent_id: agentId,
          created_at: { $gte: windowStart, $lt: windowEnd },
        },
        { projection: { created_at: 1, type: 1 } },
      )
      .toArray(),
  ]);

  // Pre-allocate one bucket per week, oldest first. Bucketing in JS (not
  // Mongo) is simpler and avoids a $bucket pipeline; the data is small
  // (~thousands of rows max for a 12-week window).
  const buckets: WeekBucket[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(windowStart.getTime() + i * WEEK_MS);
    const end = new Date(start.getTime() + WEEK_MS);
    buckets.push({
      week_start: start.toISOString(),
      week_end: end.toISOString(),
      calls: 0,
      by_type: emptyByType(),
    });
  }

  for (const row of callRows) {
    const idx = bucketIndex(row.created_at as Date, windowStart, weeks);
    if (idx >= 0) buckets[idx].calls++;
  }
  for (const row of findingRows) {
    const idx = bucketIndex(row.created_at as Date, windowStart, weeks);
    if (idx < 0) continue;
    const type = row.type as FindingType | undefined;
    if (!type || !buckets[idx].by_type.hasOwnProperty(type)) continue;
    buckets[idx].by_type[type]++;
  }

  const totals = {
    calls: buckets.reduce((s, b) => s + b.calls, 0),
    by_type: emptyByType(),
  };
  for (const b of buckets) {
    for (const t of FINDING_TYPES) totals.by_type[t] += b.by_type[t];
  }

  return {
    agent_id: agentId,
    weeks,
    window_start: windowStart.toISOString(),
    buckets,
    totals,
  };
}

function emptyByType(): Record<FindingType, number> {
  const out = {} as Record<FindingType, number>;
  for (const t of FINDING_TYPES) out[t] = 0;
  return out;
}

function bucketIndex(date: Date, windowStart: Date, weeks: number): number {
  const offset = date.getTime() - windowStart.getTime();
  if (offset < 0) return -1;
  const idx = Math.floor(offset / WEEK_MS);
  return idx < weeks ? idx : -1;
}

function floorUtcDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
