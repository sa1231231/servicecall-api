// Role-default permission storage.
//
// Historically lived as a hard-coded constant in users.ts. Now stored in
// MongoDB so super_admin / root can edit them without a deploy.
//
// Cache strategy: load all role defaults at boot into a sync map. Every
// `PATCH /role-defaults/:role` call refreshes the cache after the write.
// `requirePermission(...)` is sync and per-request hot, so we never await
// inside it — `resolvePermissions(role, stored)` reads from the cache.
//
// Stale-cache window across multiple Node instances: a few seconds (the
// time between an edit on one instance and the next request on another).
// Acceptable for a dashboard. If we ever go multi-region, swap the cache
// for a TTL'd Redis read or a Mongo change stream.

import { getDb } from "./db.js";

// Roles are duplicated here (rather than imported from users.ts) so
// users.ts can import from this module without a cycle.
export type Role = "super_admin" | "admin" | "operator" | "viewer";
export const ROLES: Role[] = ["super_admin", "admin", "operator", "viewer"];

// Permission keys must mirror PERMISSION_DEFS in users.ts. The drift
// guard in `permission-catalog.test.ts` and `users.test.ts` will fail
// CI if these get out of sync.
export const PERMISSION_KEYS_INTERNAL = [
  "create_agents",
  "edit_agents",
  "clone_agents",
  "delete_agents",
  "send_comms",
  "manage_settings",
  "manage_data_points",
  "manage_users",
  "view_billing",
  "manage_deleted",
  "manage_leads",
];

// Hard-coded seed defaults — used until the MongoDB cache is loaded
// and as a fallback if the DB is unreachable. Mirrors the original
// SEED_DEFAULTS in users.ts.
export const SEED_DEFAULTS: Record<Role, Record<string, boolean>> = {
  super_admin: Object.fromEntries(PERMISSION_KEYS_INTERNAL.map((k) => [k, true])),
  admin: Object.fromEntries(PERMISSION_KEYS_INTERNAL.map((k) => [k, k !== "view_billing" && k !== "manage_deleted"])),
  operator: {
    create_agents: true,
    edit_agents: true,
    clone_agents: true,
    delete_agents: false,
    send_comms: true,
    manage_settings: false,
    manage_data_points: false,
    manage_users: false,
    view_billing: false,
    manage_deleted: false,
    manage_leads: true,
  },
  viewer: Object.fromEntries(PERMISSION_KEYS_INTERNAL.map((k) => [k, false])),
};

interface RoleDefaultDoc {
  _id: Role;
  permissions: Record<string, boolean>;
  updated_at?: Date;
  updated_by?: string;
}

function collection() {
  return getDb().collection<RoleDefaultDoc>("role_defaults");
}

let cache: Record<Role, Record<string, boolean>> = {
  super_admin: { ...SEED_DEFAULTS.super_admin },
  admin: { ...SEED_DEFAULTS.admin },
  operator: { ...SEED_DEFAULTS.operator },
  viewer: { ...SEED_DEFAULTS.viewer },
};
let cacheLoaded = false;

/** Load every role-default doc into the in-memory cache, seeding any
 *  missing roles with the hard-coded `SEED_DEFAULTS` constant.
 *  Called at boot from index.ts.
 *
 *  Safe to call repeatedly — each call replaces the cache atomically. */
export async function loadRoleDefaultsCache(): Promise<void> {
  const docs = await collection().find({}).toArray();
  const next: Record<Role, Record<string, boolean>> = {
    super_admin: { ...SEED_DEFAULTS.super_admin },
    admin: { ...SEED_DEFAULTS.admin },
    operator: { ...SEED_DEFAULTS.operator },
    viewer: { ...SEED_DEFAULTS.viewer },
  };
  for (const doc of docs) {
    if (ROLES.includes(doc._id)) {
      next[doc._id] = mergeWithKnownKeys(doc.permissions ?? {});
    }
  }
  cache = next;
  cacheLoaded = true;
  console.log("[role-defaults] cache loaded:", JSON.stringify({
    admin_count: Object.values(cache.admin).filter(Boolean).length,
    operator_count: Object.values(cache.operator).filter(Boolean).length,
    viewer_count: Object.values(cache.viewer).filter(Boolean).length,
  }));
}

/** Merge a stored permission map with the full known-key list so any
 *  permissions added since the doc was last written default to the
 *  hardcoded constant rather than `undefined` (which would render as
 *  unchecked in the UI even if the route allows the role). */
function mergeWithKnownKeys(stored: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS_INTERNAL) {
    out[key] = key in stored ? !!stored[key] : false;
  }
  return out;
}

/** Sync read for use in `resolvePermissions(...)` and the request hot
 *  path. Returns the cached defaults; if the cache hasn't been loaded
 *  yet (e.g. during early boot), returns the hardcoded constant. */
export function getCachedRoleDefaults(role: Role): Record<string, boolean> {
  if (!cacheLoaded) return { ...SEED_DEFAULTS[role] };
  return { ...cache[role] };
}

/** Async read — used by the GET /role-defaults route. */
export async function getRoleDefaults(role: Role): Promise<Record<string, boolean>> {
  const doc = await collection().findOne({ _id: role });
  if (!doc) return { ...SEED_DEFAULTS[role] };
  return mergeWithKnownKeys(doc.permissions ?? {});
}

/** Read all four role defaults as a {role: perms} map. */
export async function getAllRoleDefaults(): Promise<Record<Role, Record<string, boolean>>> {
  const out: Record<Role, Record<string, boolean>> = {
    super_admin: { ...SEED_DEFAULTS.super_admin },
    admin: { ...SEED_DEFAULTS.admin },
    operator: { ...SEED_DEFAULTS.operator },
    viewer: { ...SEED_DEFAULTS.viewer },
  };
  for (const role of ROLES) {
    out[role] = await getRoleDefaults(role);
  }
  return out;
}

/** Write a new permission map for the given role, then refresh the
 *  cache so future requests see the change. Returns the resolved
 *  (post-merge) map that was actually stored. */
export async function setRoleDefaults(
  role: Role,
  perms: Record<string, boolean>,
  updatedBy: string,
): Promise<Record<string, boolean>> {
  if (!ROLES.includes(role)) {
    throw new Error(`Unknown role "${role}"`);
  }
  // Strict allow-list: only known permission keys make it into the doc.
  const clean: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS_INTERNAL) {
    clean[key] = !!perms[key];
  }
  await collection().updateOne(
    { _id: role },
    {
      $set: {
        permissions: clean,
        updated_at: new Date(),
        updated_by: updatedBy,
      },
    },
    { upsert: true },
  );
  await loadRoleDefaultsCache();
  return clean;
}
