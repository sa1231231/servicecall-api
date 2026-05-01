import type { Request } from "express";
/**
 * Alert root via SMS + email when a non-root user performs a destructive action.
 * Fire-and-forget — errors are logged but don't affect the response.
 */
export declare function alertRootIfNeeded(req: Request, action: string, target: string, details?: string): void;
