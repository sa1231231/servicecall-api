export type Role = "super_admin" | "admin" | "operator" | "viewer";
export declare const PERMISSION_DEFS: Array<{
    key: string;
    label: string;
    description: string;
}>;
export declare const PERMISSION_KEYS: string[];
export declare const DEFAULT_PERMISSIONS: Record<Role, Record<string, boolean>>;
export interface DashboardUser {
    _id: string;
    password_hash: string;
    role: Role;
    permissions: Record<string, boolean>;
    created_at: Date;
    created_by: string;
}
export declare function hashPassword(plain: string): string;
export declare function verifyPassword(plain: string, stored: string): boolean;
/** Resolve effective permissions for a user (admins always get everything). */
export declare function resolvePermissions(role: Role, stored?: Record<string, boolean>): Record<string, boolean>;
export declare function getUser(username: string): Promise<DashboardUser | null>;
export declare function listUsers(): Promise<Array<{
    _id: string;
    role: Role;
    permissions: Record<string, boolean>;
    created_at: Date;
}>>;
export declare function createUser(username: string, password: string, role: Role, createdBy: string, permissions?: Record<string, boolean>): Promise<void>;
export declare function updateUserPermissions(username: string, permissions: Record<string, boolean>): Promise<boolean>;
export declare function deleteUser(username: string): Promise<boolean>;
