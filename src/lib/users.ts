import crypto from "crypto";
import { getDb } from "./db.js";
import { getCachedRoleDefaults } from "./role-defaults.js";
import {
  type Level,
  FEATURE_KEYS,
  resolveFeaturePermissions as resolveFeatureLevels,
  migrateOldPermissionsToFeatureLevels,
  SEED_FEATURE_DEFAULTS,
} from "./feature-permissions.js";

export type Role = "super_admin" | "admin" | "operator" | "viewer";

// ── Legacy permission catalog (kept for migration / API compatibility) ──────
//
// The new permission system is feature × level (see feature-permissions.ts).
// PERMISSION_DEFS and DEFAULT_PERMISSIONS are retained so older code paths
// and tests keep compiling, but new code should use FEATURES + Level.

export const PERMISSION_DEFS: Array<{
  key: string;
  label: string;
  description: string;
}> = [
  { key: "create_agents",      label: "Create Agents",       description: "Access the agent creation form and deploy new agents" },
  { key: "edit_agents",        label: "Edit Agents",         description: "Edit agent config and toggle shadow mode" },
  { key: "clone_agents",       label: "Clone Agents",        description: "Clone existing agents" },
  { key: "delete_agents",      label: "Delete Agents",       description: "Delete, restore, and permanently remove agents" },
  { key: "send_comms",         label: "Send Client Comms",   description: "Send review requests and payment links" },
  { key: "manage_settings",    label: "Manage Settings",     description: "Edit global settings (business contact, SMS templates, etc.)" },
  { key: "manage_data_points", label: "Manage Data Points",  description: "Create, edit, delete, and reorder data point defaults" },
  { key: "manage_users",       label: "Manage Users",        description: "Create and remove user accounts" },
  { key: "view_billing",      label: "View Billing",        description: "View call costs, cost charts, and billing data" },
  { key: "manage_deleted",    label: "Manage Deleted",      description: "View, restore, and permanently delete soft-deleted agents" },
  { key: "manage_leads",      label: "Manage Leads",        description: "Triage incoming leads, run enrichment, and promote them to agents" },
];

export const PERMISSION_KEYS = PERMISSION_DEFS.map((d) => d.key);

// Legacy default-permissions constant. The actual runtime defaults are
// loaded from MongoDB via role-defaults.ts under the new feature shape.
export const DEFAULT_PERMISSIONS: Record<Role, Record<string, boolean>> = {
  super_admin: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])),
  admin: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, k !== "view_billing" && k !== "manage_deleted"])),
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
  viewer: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])),
};

// ── User docs ───────────────────────────────────────────────────────────────

export interface DashboardUser {
  _id: string;
  password_hash: string;
  role: Role;
  // New shape (preferred). Operator/viewer overrides per feature.
  feature_permissions?: Record<string, Level>;
  // Legacy shape — read transparently via migration.
  permissions?: Record<string, boolean>;
  created_at: Date;
  created_by: string;
}

function usersCollection() {
  return getDb().collection<DashboardUser>("users");
}

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(plain, salt, 64);
  return crypto.timingSafeEqual(expected, actual);
}

/** Legacy resolver — kept for any caller that still expects the boolean
 *  shape. New code should use `resolveUserFeaturePermissions` instead. */
export function resolvePermissions(
  role: Role,
  stored?: Record<string, boolean>,
): Record<string, boolean> {
  // The legacy seeded `DEFAULT_PERMISSIONS` is the authoritative answer
  // here. (We don't read role-defaults — those are now in the new shape.)
  if (role === "super_admin" || role === "admin") return { ...DEFAULT_PERMISSIONS[role] };
  const base = { ...DEFAULT_PERMISSIONS[role] };
  if (stored) {
    for (const key of PERMISSION_KEYS) {
      if (key in stored) base[key] = stored[key];
    }
  }
  return base;
}

/** Resolve a user doc to feature-level permissions, migrating from the
 *  legacy boolean shape if needed. Returns the effective map after
 *  applying role defaults + per-user overrides. */
export function resolveUserFeaturePermissions(user: {
  role: Role;
  feature_permissions?: Record<string, Level>;
  permissions?: Record<string, boolean>;
}): Record<string, Level> {
  const defaults = getCachedRoleDefaults(user.role);
  // Prefer the new shape if present; otherwise migrate the legacy field.
  let stored: Record<string, Level> | undefined;
  if (user.feature_permissions && Object.keys(user.feature_permissions).length > 0) {
    // Trust the stored map but fill in any missing features with "none".
    stored = {};
    for (const f of FEATURE_KEYS) {
      stored[f] = (user.feature_permissions[f] ?? "none") as Level;
    }
  } else if (user.permissions && Object.keys(user.permissions).length > 0) {
    stored = migrateOldPermissionsToFeatureLevels(user.permissions, user.role);
  }
  return resolveFeatureLevels(user.role, defaults, stored);
}

export async function getUser(username: string): Promise<DashboardUser | null> {
  return usersCollection().findOne({ _id: username });
}

export async function listUsers(): Promise<
  Array<{
    _id: string;
    role: Role;
    permissions?: Record<string, boolean>;
    feature_permissions?: Record<string, Level>;
    created_at: Date;
  }>
> {
  return usersCollection()
    .find({}, { projection: { _id: 1, role: 1, permissions: 1, feature_permissions: 1, created_at: 1 } })
    .toArray();
}

export async function createUser(
  username: string,
  password: string,
  role: Role,
  createdBy: string,
  featurePermissions?: Record<string, Level>,
): Promise<void> {
  const existing = await getUser(username);
  if (existing) throw new Error(`User "${username}" already exists`);
  await usersCollection().insertOne({
    _id: username,
    password_hash: hashPassword(password),
    role,
    feature_permissions: featurePermissions ?? { ...SEED_FEATURE_DEFAULTS[role] },
    created_at: new Date(),
    created_by: createdBy,
  });
  console.log(`[users] created user "${username}" with role "${role}"`);
}

/** Update the per-user feature permission overrides. Only meaningful for
 *  operator/viewer; for admin/super_admin the resolver ignores the
 *  stored map. */
export async function updateUserFeaturePermissions(
  username: string,
  featurePermissions: Record<string, Level>,
): Promise<boolean> {
  const valid: Level[] = ["none", "read", "write", "manage"];
  const clean: Record<string, Level> = {};
  for (const f of FEATURE_KEYS) {
    const incoming = featurePermissions[f];
    clean[f] = (typeof incoming === "string" && valid.includes(incoming as Level))
      ? (incoming as Level)
      : "none";
  }
  const result = await usersCollection().updateOne(
    { _id: username },
    { $set: { feature_permissions: clean }, $unset: { permissions: "" } },
  );
  if (result.matchedCount > 0) {
    console.log(`[users] updated feature permissions for "${username}"`);
    return true;
  }
  return false;
}

/** Deprecated: use `updateUserFeaturePermissions` for the new shape.
 *  Kept so existing test setups keep compiling. */
export async function updateUserPermissions(
  username: string,
  permissions: Record<string, boolean>,
): Promise<boolean> {
  const clean: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS) {
    if (key in permissions) clean[key] = !!permissions[key];
  }
  const result = await usersCollection().updateOne(
    { _id: username },
    { $set: { permissions: clean } },
  );
  return result.matchedCount > 0;
}

export async function deleteUser(username: string): Promise<boolean> {
  const result = await usersCollection().deleteOne({ _id: username });
  if (result.deletedCount > 0) {
    console.log(`[users] deleted user "${username}"`);
    return true;
  }
  return false;
}
