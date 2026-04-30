import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hashPassword,
  verifyPassword,
  resolvePermissions,
  PERMISSION_KEYS,
  PERMISSION_DEFS,
  DEFAULT_PERMISSIONS,
} from "../users.js";

// ── DB function mocks (lazy-loaded to avoid hoisting issues with pure imports) ──
const mockDbFindOne = vi.fn();
const mockDbFind = vi.fn();
const mockDbInsertOne = vi.fn();
const mockDbUpdateOne = vi.fn();
const mockDbDeleteOne = vi.fn();

// ── hashPassword / verifyPassword ───────────────────────────────────────────

describe("hashPassword + verifyPassword", () => {
  it("verifies a correct password", () => {
    const hash = hashPassword("mypassword");
    expect(verifyPassword("mypassword", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("mypassword");
    expect(verifyPassword("wrongpassword", hash)).toBe(false);
  });

  it("produces different hashes for the same password (random salt)", () => {
    const h1 = hashPassword("same");
    const h2 = hashPassword("same");
    expect(h1).not.toBe(h2);
    // But both verify correctly
    expect(verifyPassword("same", h1)).toBe(true);
    expect(verifyPassword("same", h2)).toBe(true);
  });

  it("returns false for malformed stored hash (no colon)", () => {
    expect(verifyPassword("anything", "nocolonhere")).toBe(false);
  });

  it("returns false for empty stored hash", () => {
    expect(verifyPassword("anything", "")).toBe(false);
  });

  it("returns false for empty salt", () => {
    expect(verifyPassword("anything", ":abc123")).toBe(false);
  });

  it("hash format is salt:hash in hex", () => {
    const hash = hashPassword("test");
    const parts = hash.split(":");
    expect(parts).toHaveLength(2);
    // Salt is 16 bytes = 32 hex chars
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
    // Hash is 64 bytes = 128 hex chars
    expect(parts[1]).toMatch(/^[0-9a-f]{128}$/);
  });
});

// ── PERMISSION_DEFS / PERMISSION_KEYS ───────────────────────────────────────

describe("PERMISSION_DEFS", () => {
  it("has at least 7 permissions defined", () => {
    expect(PERMISSION_DEFS.length).toBeGreaterThanOrEqual(7);
  });

  it("each permission has key, label, and description", () => {
    for (const def of PERMISSION_DEFS) {
      expect(def.key).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });

  it("PERMISSION_KEYS matches PERMISSION_DEFS keys", () => {
    expect(PERMISSION_KEYS).toEqual(PERMISSION_DEFS.map((d) => d.key));
  });

  it("includes create_agents permission", () => {
    expect(PERMISSION_KEYS).toContain("create_agents");
  });
});

// ── DEFAULT_PERMISSIONS ─────────────────────────────────────────────────────

describe("DEFAULT_PERMISSIONS", () => {
  it("super_admin has all permissions set to true", () => {
    for (const key of PERMISSION_KEYS) {
      expect(DEFAULT_PERMISSIONS.super_admin[key]).toBe(true);
    }
  });

  it("admin has most permissions true but not billing/deleted", () => {
    expect(DEFAULT_PERMISSIONS.admin.create_agents).toBe(true);
    expect(DEFAULT_PERMISSIONS.admin.edit_agents).toBe(true);
    expect(DEFAULT_PERMISSIONS.admin.view_billing).toBe(false);
    expect(DEFAULT_PERMISSIONS.admin.manage_deleted).toBe(false);
  });

  it("viewer has all permissions set to false", () => {
    for (const key of PERMISSION_KEYS) {
      expect(DEFAULT_PERMISSIONS.viewer[key]).toBe(false);
    }
  });

  it("operator has some permissions true and some false", () => {
    const op = DEFAULT_PERMISSIONS.operator;
    expect(op.create_agents).toBe(true);
    expect(op.edit_agents).toBe(true);
    expect(op.clone_agents).toBe(true);
    expect(op.send_comms).toBe(true);
    expect(op.delete_agents).toBe(false);
    expect(op.manage_settings).toBe(false);
    expect(op.manage_data_points).toBe(false);
    expect(op.manage_users).toBe(false);
  });
});

// ── resolvePermissions ──────────────────────────────────────────────────────

describe("resolvePermissions", () => {
  it("super_admin always gets all permissions regardless of stored", () => {
    const perms = resolvePermissions("super_admin", { delete_agents: false });
    expect(perms.delete_agents).toBe(true);
    for (const key of PERMISSION_KEYS) {
      expect(perms[key]).toBe(true);
    }
  });

  it("operator gets defaults when no stored permissions", () => {
    const perms = resolvePermissions("operator");
    expect(perms).toEqual(DEFAULT_PERMISSIONS.operator);
  });

  it("operator stored permissions override defaults", () => {
    const perms = resolvePermissions("operator", {
      delete_agents: true,
      manage_settings: true,
    });
    expect(perms.delete_agents).toBe(true);
    expect(perms.manage_settings).toBe(true);
    // Non-overridden defaults preserved
    expect(perms.edit_agents).toBe(true);
    expect(perms.manage_users).toBe(false);
  });

  it("viewer gets defaults when no stored permissions", () => {
    const perms = resolvePermissions("viewer");
    for (const key of PERMISSION_KEYS) {
      expect(perms[key]).toBe(false);
    }
  });

  it("viewer stored permissions can enable features", () => {
    const perms = resolvePermissions("viewer", { edit_agents: true });
    expect(perms.edit_agents).toBe(true);
    expect(perms.clone_agents).toBe(false);
  });

  it("ignores unknown permission keys in stored", () => {
    const perms = resolvePermissions("operator", {
      bogus_key: true,
      edit_agents: false,
    } as any);
    expect(perms.edit_agents).toBe(false);
    expect((perms as any).bogus_key).toBeUndefined();
  });
});

// ── DB Functions (mocked) ─────────────────────────────────────────────────
// These test the DB-backed functions: createUser, getUser, listUsers,
// updateUserPermissions, deleteUser

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      findOne: mockDbFindOne,
      find: mockDbFind,
      insertOne: mockDbInsertOne,
      updateOne: mockDbUpdateOne,
      deleteOne: mockDbDeleteOne,
    }),
  }),
}));

// Re-import after mock is set up
const { createUser, getUser, listUsers, updateUserPermissions, deleteUser } = await import("../users.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockDbFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
});

describe("createUser", () => {
  it("creates user with default permissions for role", async () => {
    mockDbFindOne.mockResolvedValue(null);
    mockDbInsertOne.mockResolvedValue({});

    await createUser("newuser", "pass123", "operator", "admin");

    expect(mockDbInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "newuser",
        role: "operator",
        permissions: DEFAULT_PERMISSIONS.operator,
      }),
    );
  });

  it("creates super_admin with all permissions", async () => {
    mockDbFindOne.mockResolvedValue(null);
    mockDbInsertOne.mockResolvedValue({});

    await createUser("superuser", "pass123", "super_admin", "root");

    const inserted = mockDbInsertOne.mock.calls[0][0];
    expect(inserted.role).toBe("super_admin");
    for (const key of PERMISSION_KEYS) {
      expect(inserted.permissions[key]).toBe(true);
    }
  });

  it("uses custom permissions when provided", async () => {
    mockDbFindOne.mockResolvedValue(null);
    mockDbInsertOne.mockResolvedValue({});

    const custom = { create_agents: false, edit_agents: true };
    await createUser("custom", "pass", "operator", "admin", custom);

    expect(mockDbInsertOne.mock.calls[0][0].permissions).toEqual(custom);
  });

  it("throws when user already exists", async () => {
    mockDbFindOne.mockResolvedValue({ _id: "existing" });

    await expect(createUser("existing", "pass", "operator", "admin"))
      .rejects.toThrow("already exists");
    expect(mockDbInsertOne).not.toHaveBeenCalled();
  });
});

describe("getUser", () => {
  it("returns user when found", async () => {
    const user = { _id: "sam", role: "admin", permissions: {} };
    mockDbFindOne.mockResolvedValue(user);
    expect(await getUser("sam")).toEqual(user);
  });

  it("returns null when not found", async () => {
    mockDbFindOne.mockResolvedValue(null);
    expect(await getUser("nobody")).toBeNull();
  });
});

describe("listUsers", () => {
  it("returns array from MongoDB", async () => {
    const users = [{ _id: "sam", role: "admin" }];
    mockDbFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue(users) });
    expect(await listUsers()).toEqual(users);
  });
});

describe("updateUserPermissions", () => {
  it("strips unknown keys and updates", async () => {
    mockDbUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const result = await updateUserPermissions("sam", {
      create_agents: true,
      bogus_key: true,
      edit_agents: false,
    } as any);

    expect(result).toBe(true);
    const perms = mockDbUpdateOne.mock.calls[0][1].$set.permissions;
    expect(perms.create_agents).toBe(true);
    expect(perms.edit_agents).toBe(false);
    expect(perms.bogus_key).toBeUndefined();
  });

  it("returns false when user not found", async () => {
    mockDbUpdateOne.mockResolvedValue({ matchedCount: 0 });
    expect(await updateUserPermissions("nobody", {})).toBe(false);
  });
});

describe("deleteUser", () => {
  it("returns true when user deleted", async () => {
    mockDbDeleteOne.mockResolvedValue({ deletedCount: 1 });
    expect(await deleteUser("sam")).toBe(true);
  });

  it("returns false when user not found", async () => {
    mockDbDeleteOne.mockResolvedValue({ deletedCount: 0 });
    expect(await deleteUser("nobody")).toBe(false);
  });
});
