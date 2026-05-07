import type { Request, Response, NextFunction } from "express";
import { hasFeatureLevel, type Level } from "../lib/feature-permissions.js";

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

/** Gate that allows super_admin OR root. Used for the User Management
 *  section and the role-defaults editor — features regular admins
 *  shouldn't be able to grant themselves access to. */
export function requireSuperAdminOrRoot(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (req.user.role !== "super_admin" && !req.user.isRoot) {
    res.status(403).json({ error: "Super admin or root required" });
    return;
  }
  next();
}

/** Gate that requires the user's effective level for `feature` to meet
 *  or exceed `level`. Reads from `req.user.featurePermissions`, which
 *  is set at session-auth time. */
export function requireFeature(feature: string, level: Level) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    // Root bypasses every feature gate (it bypasses requirePermission too).
    if (req.user.isRoot) {
      next();
      return;
    }
    if (!hasFeatureLevel(req.user.featurePermissions, feature, level)) {
      res.status(403).json({
        error: `Insufficient permissions: requires ${feature}:${level}`,
      });
      return;
    }
    next();
  };
}

export const ROOT_ONLY_DELETE_SLUGS = new Set<string>(["demo-meter"]);

export function requireRootForProtectedSlug(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const slug = String(req.params.slug ?? "");
  if (ROOT_ONLY_DELETE_SLUGS.has(slug) && !req.user?.isRoot) {
    res.status(403).json({ error: "Root access required to delete this agent" });
    return;
  }
  next();
}
