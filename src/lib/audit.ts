import type { Request } from "express";
import { getDb } from "./db.js";

export async function logAudit(
  req: Request,
  action: string,
  target: string,
  details?: Record<string, unknown>,
): Promise<void> {
  const entry = {
    timestamp: new Date(),
    username: req.user?.username ?? "unknown",
    role: req.user?.role ?? "unknown",
    action,
    target,
    details,
    ip: req.ip ?? "unknown",
  };
  await getDb().collection("audit_log").insertOne(entry);
  console.log(`[audit] ${entry.username} (${entry.role}) ${action} ${target}`);
}

export async function ensureAuditIndex(): Promise<void> {
  await getDb()
    .collection("audit_log")
    .createIndex({ timestamp: 1 }, { expireAfterSeconds: 90 * 86400 });
}
