import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

export function requireServiceToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = config.LEAD_INTAKE_TOKEN;
  if (!expected) {
    res.status(401).json({ error: "Service token not configured" });
    return;
  }
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const got = Buffer.from(m[1]);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  next();
}
