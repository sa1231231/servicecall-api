import type { Request, Response } from "express";
import { getClientDocument } from "../../config/client-store.js";
import { getDb } from "../../lib/db.js";

// Audit-log targets are written as either `${slug}` or `${slug}/${agentId}`
// across the various route handlers. Match both via a regex anchored to the
// slug + an optional `/` separator.
function targetPrefixRegex(slug: string): RegExp {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(/|$)`);
}

interface LastEdit {
  username: string;
  action: string;
  timestamp: Date;
}

async function fetchLastEdit(slug: string): Promise<LastEdit | null> {
  // Best-effort enrichment — never block the detail page on a missing or
  // slow audit_log query.
  try {
    const entry = await getDb()
      .collection("audit_log")
      .findOne(
        { target: { $regex: targetPrefixRegex(slug) } },
        {
          sort: { timestamp: -1 },
          projection: { username: 1, action: 1, timestamp: 1 },
        },
      );
    if (!entry) return null;
    return {
      username: typeof entry.username === "string" ? entry.username : "unknown",
      action: typeof entry.action === "string" ? entry.action : "edit",
      timestamp: entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp),
    };
  } catch (err) {
    console.warn(`[get-agent] last_edit lookup failed for "${slug}":`, err);
    return null;
  }
}

export async function getAgentHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = req.params.slug as string;

  try {
    const doc = await getClientDocument(slug);
    if (!doc) {
      res.status(404).json({ error: `Client "${slug}" not found` });
      return;
    }
    const lastEdit = await fetchLastEdit(slug);
    res.json(lastEdit ? { ...doc, last_edit: lastEdit } : doc);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}
