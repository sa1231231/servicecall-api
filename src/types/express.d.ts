declare global {
  namespace Express {
    interface Request {
      user?: {
        username: string;
        role: "super_admin" | "admin" | "operator" | "viewer";
        permissions: Record<string, boolean>;
        // Feature × level map: each feature key (e.g. "agent_config")
        // points to "none" | "read" | "write" | "manage". Computed at
        // session-auth time from the role default + per-user override.
        // Optional during the migration window — old session cookies
        // and a few test fixtures don't carry it. requireFeature(...)
        // treats `undefined` as `none`.
        featurePermissions?: Record<string, "none" | "read" | "write" | "manage">;
        isRoot: boolean;
      };
    }
  }
}

export {};
