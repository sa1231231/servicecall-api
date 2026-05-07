import type { Request, Response } from "express";
import { getDb } from "../../lib/db.js";

interface AuditEntry {
  timestamp: Date;
  username: string;
  role: string;
  action: string;
  target: string;
  details?: Record<string, unknown>;
  ip?: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_WINDOW_DAYS = 30;
const DISTINCT_WINDOW_DAYS = 30;

function parseDate(s: unknown): Date | null {
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseLimit(q: unknown): number {
  const n = parseInt(String(q ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(q: unknown): number {
  const n = parseInt(String(q ?? ""), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * GET /dashboard/api/audit-log
 *
 * Query params (all optional):
 *   action      exact match (e.g. "delete_agent")
 *   username    exact match
 *   target      prefix match against `slug` or `slug/agent_id`
 *   since       ISO 8601 — defaults to 30 days ago
 *   until       ISO 8601 — defaults to now
 *   limit       1..500, default 100
 *   offset      pagination cursor, default 0
 *
 * Returns:
 *   {
 *     entries:   AuditEntry[],   // newest first
 *     total:     number,         // total matching the filter (not just this page)
 *     hasMore:   boolean,        // total > offset + entries.length
 *     actions:   string[],       // distinct action values seen in the past 30 days
 *     usernames: string[],       // distinct usernames seen in the past 30 days
 *   }
 *
 * The `actions` / `usernames` companion arrays let the UI populate filter
 * dropdowns without a second round-trip — they're cheap because the
 * collection has a 90-day TTL and we limit the distinct() to 30 days.
 */
export async function auditLogHandler(req: Request, res: Response): Promise<void> {
  const action = typeof req.query.action === "string" && req.query.action ? req.query.action : undefined;
  const username = typeof req.query.username === "string" && req.query.username ? req.query.username : undefined;
  const targetPrefix = typeof req.query.target === "string" && req.query.target ? req.query.target : undefined;
  const since = parseDate(req.query.since)
    ?? new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400 * 1000);
  const until = parseDate(req.query.until) ?? new Date();
  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);

  const filter: Record<string, unknown> = {
    timestamp: { $gte: since, $lte: until },
  };
  if (action) filter.action = action;
  if (username) filter.username = username;
  if (targetPrefix) filter.target = { $regex: `^${escapeRegex(targetPrefix)}` };

  const col = getDb().collection<AuditEntry>("audit_log");

  // Run filtered query, total count, and distinct value queries in parallel.
  const distinctSince = new Date(Date.now() - DISTINCT_WINDOW_DAYS * 86400 * 1000);
  const [entries, total, actions, usernames] = await Promise.all([
    col
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .toArray(),
    col.countDocuments(filter),
    col.distinct("action", { timestamp: { $gte: distinctSince } }),
    col.distinct("username", { timestamp: { $gte: distinctSince } }),
  ]);

  res.json({
    entries,
    total,
    hasMore: offset + entries.length < total,
    actions: (actions as string[]).filter(Boolean).sort(),
    usernames: (usernames as string[]).filter(Boolean).sort(),
  });
}
