export function requireRole(...allowed) {
    return (req, res, next) => {
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
export function requirePermission(perm) {
    return (req, res, next) => {
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
export function requireRoot(req, res, next) {
    if (!req.user || !req.user.isRoot) {
        res.status(403).json({ error: "Root access required" });
        return;
    }
    next();
}
export const ROOT_ONLY_DELETE_SLUGS = new Set(["demo-meter"]);
export function requireRootForProtectedSlug(req, res, next) {
    const slug = String(req.params.slug ?? "");
    if (ROOT_ONLY_DELETE_SLUGS.has(slug) && !req.user?.isRoot) {
        res.status(403).json({ error: "Root access required to delete this agent" });
        return;
    }
    next();
}
