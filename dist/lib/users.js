import crypto from "crypto";
import { getDb } from "./db.js";
// Granular permission keys
export const PERMISSION_DEFS = [
    { key: "create_agents", label: "Create Agents", description: "Access the agent creation form and deploy new agents" },
    { key: "edit_agents", label: "Edit Agents", description: "Edit agent config and toggle shadow mode" },
    { key: "clone_agents", label: "Clone Agents", description: "Clone existing agents" },
    { key: "delete_agents", label: "Delete Agents", description: "Delete, restore, and permanently remove agents" },
    { key: "send_comms", label: "Send Client Comms", description: "Send review requests and payment links" },
    { key: "manage_settings", label: "Manage Settings", description: "Edit global settings (business contact, SMS templates, etc.)" },
    { key: "manage_data_points", label: "Manage Data Points", description: "Create, edit, delete, and reorder data point defaults" },
    { key: "manage_users", label: "Manage Users", description: "Create and remove user accounts" },
    { key: "view_billing", label: "View Billing", description: "View call costs, cost charts, and billing data" },
    { key: "manage_deleted", label: "Manage Deleted", description: "View, restore, and permanently delete soft-deleted agents" },
    { key: "manage_leads", label: "Manage Leads", description: "Triage incoming leads, run enrichment, and promote them to agents" },
];
export const PERMISSION_KEYS = PERMISSION_DEFS.map((d) => d.key);
// Default permissions per role (used when creating new users)
export const DEFAULT_PERMISSIONS = {
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
function usersCollection() {
    return getDb().collection("users");
}
export function hashPassword(plain) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(plain, salt, 64);
    return salt.toString("hex") + ":" + hash.toString("hex");
}
export function verifyPassword(plain, stored) {
    const [saltHex, hashHex] = stored.split(":");
    if (!saltHex || !hashHex)
        return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(plain, salt, 64);
    return crypto.timingSafeEqual(expected, actual);
}
/** Resolve effective permissions for a user (admins always get everything). */
export function resolvePermissions(role, stored) {
    if (role === "super_admin")
        return { ...DEFAULT_PERMISSIONS.super_admin };
    if (role === "admin")
        return { ...DEFAULT_PERMISSIONS.admin };
    const base = { ...DEFAULT_PERMISSIONS[role] };
    if (stored) {
        for (const key of PERMISSION_KEYS) {
            if (key in stored)
                base[key] = stored[key];
        }
    }
    return base;
}
export async function getUser(username) {
    return usersCollection().findOne({ _id: username });
}
export async function listUsers() {
    return usersCollection()
        .find({}, { projection: { _id: 1, role: 1, permissions: 1, created_at: 1 } })
        .toArray();
}
export async function createUser(username, password, role, createdBy, permissions) {
    const existing = await getUser(username);
    if (existing)
        throw new Error(`User "${username}" already exists`);
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
export async function updateUserPermissions(username, permissions) {
    // Only allow known permission keys
    const clean = {};
    for (const key of PERMISSION_KEYS) {
        if (key in permissions)
            clean[key] = !!permissions[key];
    }
    const result = await usersCollection().updateOne({ _id: username }, { $set: { permissions: clean } });
    if (result.matchedCount > 0) {
        console.log(`[users] updated permissions for "${username}"`);
        return true;
    }
    return false;
}
export async function deleteUser(username) {
    const result = await usersCollection().deleteOne({ _id: username });
    if (result.deletedCount > 0) {
        console.log(`[users] deleted user "${username}"`);
        return true;
    }
    return false;
}
