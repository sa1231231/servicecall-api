import type { Request, Response, NextFunction } from "express";
export declare function requireRole(...allowed: Array<"super_admin" | "admin" | "operator" | "viewer">): (req: Request, res: Response, next: NextFunction) => void;
export declare function requirePermission(perm: string): (req: Request, res: Response, next: NextFunction) => void;
export declare const adminOnly: (req: Request, res: Response, next: NextFunction) => void;
export declare function requireRoot(req: Request, res: Response, next: NextFunction): void;
