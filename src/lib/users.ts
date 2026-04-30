import crypto from "crypto";
import { getDb } from "./db.js";

export type Role = "super_admin" | "admin" | "operator" | "viewer";

// Granular permission keys
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
];

export const PERMISSION_KEYS = PERMISSION_DEFS.map((d) => d.key);

// Default permissions per role (used when creating new users)
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
  },
  viewer: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])),
};

export interface DashboardUser {
  _id: string;
  password_hash: string;
  role: Role;
  permissions: Record<string, boolean>;
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

/** Resolve effective permissions for a user (admins always get everything). */
export function resolvePermissions(
  role: Role,
  stored?: Record<string, boolean>,
): Record<string, boolean> {
  if (role === "super_admin") return { ...DEFAULT_PERMISSIONS.super_admin };
  if (role === "admin") return { ...DEFAULT_PERMISSIONS.admin };
  const base = { ...DEFAULT_PERMISSIONS[role] };
  if (stored) {
    for (const key of PERMISSION_KEYS) {
      if (key in stored) base[key] = stored[key];
    }
  }
  return base;
}

export async function getUser(username: string): Promise<DashboardUser | null> {
  return usersCollection().findOne({ _id: username });
}

export async function listUsers(): Promise<
  Array<{ _id: string; role: Role; permissions: Record<string, boolean>; created_at: Date }>
> {
  return usersCollection()
    .find({}, { projection: { _id: 1, role: 1, permissions: 1, created_at: 1 } })
    .toArray();
}

export async function createUser(
  username: string,
  password: string,
  role: Role,
  createdBy: string,
  permissions?: Record<string, boolean>,
): Promise<void> {
  const existing = await getUser(username);
  if (existing) throw new Error(`User "${username}" already exists`);
  await usersCollection().insertOne({
    _id: username,
    password_hash: hashPassword(password),
    role,
    permissions: permissions ?? { ...DEFAULT_PERMISSIONS[role] },
    created_at: new Date(),
    created_by: createdBy,
  });
  console.log(`[users] created user "${username}" with role "${role}"`);
}

export async function updateUserPermissions(
  username: string,
  permissions: Record<string, boolean>,
): Promise<boolean> {
  // Only allow known permission keys
  const clean: Record<string, boolean> = {};
  for (const key of PERMISSION_KEYS) {
    if (key in permissions) clean[key] = !!permissions[key];
  }
  const result = await usersCollection().updateOne(
    { _id: username },
    { $set: { permissions: clean } },
  );
  if (result.matchedCount > 0) {
    console.log(`[users] updated permissions for "${username}"`);
    return true;
  }
  return false;
}

export async function deleteUser(username: string): Promise<boolean> {
  const result = await usersCollection().deleteOne({ _id: username });
  if (result.deletedCount > 0) {
    console.log(`[users] deleted user "${username}"`);
    return true;
  }
  return false;
}
