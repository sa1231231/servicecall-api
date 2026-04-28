import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  resolvePermissions,
  PERMISSION_KEYS,
  PERMISSION_DEFS,
  DEFAULT_PERMISSIONS,
} from "../users.js";

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
  it("admin has all permissions set to true", () => {
    for (const key of PERMISSION_KEYS) {
      expect(DEFAULT_PERMISSIONS.admin[key]).toBe(true);
    }
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
  it("admin always gets all permissions regardless of stored", () => {
    const perms = resolvePermissions("admin", { delete_agents: false });
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
