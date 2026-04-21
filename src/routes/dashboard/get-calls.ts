import type { Request, Response } from "express";
import { getCallLogsByClient } from "../../lib/call-log.js";

export async function getCallsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const slug = req.params.slug as string;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  try {
    const calls = await getCallLogsByClient(slug, limit, offset);
    res.json(calls);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}
