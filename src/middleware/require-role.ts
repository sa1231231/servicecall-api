import type { Request, Response, NextFunction } from "express";

export function requireRole(...allowed: Array<"super_admin" | "admin" | "operator" | "viewer">) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export function requirePermission(perm: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!req.user.permissions[perm]) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

export const adminOnly = requireRole("admin");

export function requireRoot(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !req.user.isRoot) {
    res.status(403).json({ error: "Root access required" });
    return;
  }
  next();
}
