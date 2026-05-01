import type { Request } from "express";
export declare function logAudit(req: Request, action: string, target: string, details?: Record<string, unknown>): Promise<void>;
export declare function ensureAuditIndex(): Promise<void>;
