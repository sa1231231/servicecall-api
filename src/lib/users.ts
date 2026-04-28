import crypto from "crypto";
import { getDb } from "./db.js";

export type Role = "admin" | "operator";

interface DashboardUser {
  _id: string;
  password_hash: string;
  role: Role;
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

export async function getUser(username: string): Promise<DashboardUser | null> {
  return usersCollection().findOne({ _id: username });
}

export async function listUsers(): Promise<
  Array<{ _id: string; role: Role; created_at: Date }>
> {
  return usersCollection()
    .find({}, { projection: { _id: 1, role: 1, created_at: 1 } })
    .toArray();
}

export async function createUser(
  username: string,
  password: string,
  role: Role,
  createdBy: string,
): Promise<void> {
  const existing = await getUser(username);
  if (existing) throw new Error(`User "${username}" already exists`);
  await usersCollection().insertOne({
    _id: username,
    password_hash: hashPassword(password),
    role,
    created_at: new Date(),
    created_by: createdBy,
  });
  console.log(`[users] created user "${username}" with role "${role}"`);
}

export async function deleteUser(username: string): Promise<boolean> {
  const result = await usersCollection().deleteOne({ _id: username });
  if (result.deletedCount > 0) {
    console.log(`[users] deleted user "${username}"`);
    return true;
  }
  return false;
}
