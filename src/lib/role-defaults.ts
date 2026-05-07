// Role-default permission storage.
//
// Stored as docs in the `role_defaults` collection (`_id: <role>`). Each
// doc carries the new feature/level shape:
//   { _id: "operator", feature_permissions: { agent_config: "write", ... } }
//
// Backward compat: docs written under the old shape (`permissions:
// {edit_agents: true, ...}`) are migrated on read via
// `migrateOldPermissionsToFeatureLevels`.
//
// Cache strategy: load all role defaults at boot into a sync map. Every
// `PATCH /role-defaults/:role` call refreshes the cache so the request
// hot path (`requireFeature`) never awaits.

import { getDb } from "./db.js";
import {
  ROLES,
  type Role,
  type Level,
  FEATURE_KEYS,
  SEED_FEATURE_DEFAULTS,
  migrateOldPermissionsToFeatureLevels,
} from "./feature-permissions.js";

export type { Role, Level } from "./feature-permissions.js";
export { ROLES } from "./feature-permissions.js";
// Re-exported under the historical name for callers that haven't migrated.
export const SEED_DEFAULTS = SEED_FEATURE_DEFAULTS;

interface RoleDefaultDoc {
  _id: Role;
  // New shape — written by setRoleDefaults().
  feature_permissions?: Record<string, Level>;
  // Legacy shape — read transparently via migration.
  permissions?: Record<string, boolean>;
  updated_at?: Date;
  updated_by?: string;
}

function collection() {
  return getDb().collection<RoleDefaultDoc>("role_defaults");
}

let cache: Record<Role, Record<string, Level>> = {
  super_admin: { ...SEED_FEATURE_DEFAULTS.super_admin },
  admin: { ...SEED_FEATURE_DEFAULTS.admin },
  operator: { ...SEED_FEATURE_DEFAULTS.operator },
  viewer: { ...SEED_FEATURE_DEFAULTS.viewer },
};
let cacheLoaded = false;

/** Read a role-default doc and resolve to the new feature/level shape,
 *  migrating from the legacy boolean shape if needed. */
function resolveDoc(doc: RoleDefaultDoc | null, role: Role): Record<string, Level> {
  if (!doc) return { ...SEED_FEATURE_DEFAULTS[role] };
  if (doc.feature_permissions && Object.keys(doc.feature_permissions).length > 0) {
    return mergeWithKnownFeatures(doc.feature_permissions);
  }
  if (doc.permissions) {
    return migrateOldPermissionsToFeatureLevels(doc.permissions, role);
  }
  return { ...SEED_FEATURE_DEFAULTS[role] };
}

function mergeWithKnownFeatures(stored: Record<string, Level>): Record<string, Level> {
  const out: Record<string, Level> = {};
  for (const f of FEATURE_KEYS) {
    out[f] = (stored[f] ?? "none") as Level;
  }
  return out;
}

/** Load every role-default doc into the in-memory cache. Safe to call
 *  repeatedly — each call replaces the cache atomically. */
export async function loadRoleDefaultsCache(): Promise<void> {
  const docs = await collection().find({}).toArray();
  const docByRole = new Map<Role, RoleDefaultDoc>();
  for (const d of docs) if (ROLES.includes(d._id)) docByRole.set(d._id, d);

  const next: Record<Role, Record<string, Level>> = {
    super_admin: resolveDoc(docByRole.get("super_admin") ?? null, "super_admin"),
    admin: resolveDoc(docByRole.get("admin") ?? null, "admin"),
    operator: resolveDoc(docByRole.get("operator") ?? null, "operator"),
    viewer: resolveDoc(docByRole.get("viewer") ?? null, "viewer"),
  };
  cache = next;
  cacheLoaded = true;
  console.log("[role-defaults] cache loaded (feature shape) — admin/operator/viewer feature counts:",
    Object.values(cache.admin).filter((l) => l !== "none").length,
    "/",
    Object.values(cache.operator).filter((l) => l !== "none").length,
    "/",
    Object.values(cache.viewer).filter((l) => l !== "none").length,
  );
}

/** Sync read for `requireFeature(...)` / `resolveFeaturePermissions`. */
export function getCachedRoleDefaults(role: Role): Record<string, Level> {
  if (!cacheLoaded) return { ...SEED_FEATURE_DEFAULTS[role] };
  return { ...cache[role] };
}

/** Async read — used by GET /role-defaults. */
export async function getRoleDefaults(role: Role): Promise<Record<string, Level>> {
  const doc = await collection().findOne({ _id: role });
  return resolveDoc(doc, role);
}

/** Read all four role defaults as a {role: perms} map. */
export async function getAllRoleDefaults(): Promise<Record<Role, Record<string, Level>>> {
  const out: Record<Role, Record<string, Level>> = {
    super_admin: { ...SEED_FEATURE_DEFAULTS.super_admin },
    admin: { ...SEED_FEATURE_DEFAULTS.admin },
    operator: { ...SEED_FEATURE_DEFAULTS.operator },
    viewer: { ...SEED_FEATURE_DEFAULTS.viewer },
  };
  for (const role of ROLES) {
    out[role] = await getRoleDefaults(role);
  }
  return out;
}

/** Write a feature/level map for the given role, then refresh the cache. */
export async function setRoleDefaults(
  role: Role,
  perms: Record<string, Level>,
  updatedBy: string,
): Promise<Record<string, Level>> {
  if (!ROLES.includes(role)) {
    throw new Error(`Unknown role "${role}"`);
  }
  // Strict allow-list: only known feature keys, only valid levels.
  const valid: Level[] = ["none", "read", "write", "manage"];
  const clean: Record<string, Level> = {};
  for (const f of FEATURE_KEYS) {
    const incoming = perms[f];
    clean[f] = (typeof incoming === "string" && valid.includes(incoming as Level))
      ? (incoming as Level)
      : "none";
  }
  await collection().updateOne(
    { _id: role },
    {
      $set: {
        feature_permissions: clean,
        updated_at: new Date(),
        updated_by: updatedBy,
      },
      // Drop the legacy field if the doc still has it.
      $unset: { permissions: "" },
    },
    { upsert: true },
  );
  await loadRoleDefaultsCache();
  return clean;
}
