import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFind, mockFindOne, mockUpdateOne } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockFindOne: vi.fn(),
  mockUpdateOne: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      find: () => ({ toArray: mockFind }),
      findOne: mockFindOne,
      updateOne: mockUpdateOne,
    }),
  }),
}));

const {
  loadRoleDefaultsCache,
  getCachedRoleDefaults,
  getRoleDefaults,
  setRoleDefaults,
  SEED_DEFAULTS,
} = await import("../role-defaults.js");

beforeEach(() => {
  mockFind.mockReset();
  mockFindOne.mockReset();
  mockUpdateOne.mockReset();
});

describe("role-defaults cache (feature/level shape)", () => {
  it("falls back to SEED_DEFAULTS when cache is unloaded", () => {
    const perms = getCachedRoleDefaults("operator");
    expect(perms).toHaveProperty("agent_config");
    expect(perms).toHaveProperty("pending_leads");
  });

  it("loads role defaults (feature shape) from MongoDB into the cache", async () => {
    mockFind.mockResolvedValue([
      { _id: "operator", feature_permissions: { ...SEED_DEFAULTS.operator, pending_leads: "none" } },
    ]);
    await loadRoleDefaultsCache();
    expect(getCachedRoleDefaults("operator").pending_leads).toBe("none");
    expect(getCachedRoleDefaults("viewer")).toEqual(SEED_DEFAULTS.viewer);
  });

  it("migrates a legacy boolean doc on load", async () => {
    // Legacy shape: { permissions: { manage_leads: false, ...} }
    mockFind.mockResolvedValue([
      { _id: "operator", permissions: { manage_leads: false } },
    ]);
    await loadRoleDefaultsCache();
    // The migrator should drop pending_leads to "none" because the
    // legacy "manage_leads: false" override clamps it.
    expect(getCachedRoleDefaults("operator").pending_leads).toBe("none");
  });
});

describe("getRoleDefaults (async DB read)", () => {
  it("returns SEED_DEFAULTS when the doc is absent", async () => {
    mockFindOne.mockResolvedValue(null);
    const perms = await getRoleDefaults("admin");
    expect(perms).toEqual(SEED_DEFAULTS.admin);
  });

  it("returns the new-shape stored doc unchanged (after merge)", async () => {
    mockFindOne.mockResolvedValue({
      _id: "operator",
      feature_permissions: { agent_config: "read", node_editor: "write" },
    });
    const perms = await getRoleDefaults("operator");
    expect(perms.agent_config).toBe("read");
    expect(perms.node_editor).toBe("write");
    // Missing features default to "none".
    expect(perms.users).toBe("none");
  });
});

describe("setRoleDefaults", () => {
  it("rejects unknown roles", async () => {
    await expect(setRoleDefaults("ceo" as never, {}, "alice")).rejects.toThrow(/Unknown role/);
  });

  it("strips unknown features and invalid levels before writing", async () => {
    mockFind.mockResolvedValue([]);
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    await setRoleDefaults("operator", {
      agent_config: "write",
      __evil_feature: "manage" as never,
      // Invalid level → coerced to "none"
      node_editor: "BOGUS" as never,
    }, "alice");
    const update = mockUpdateOne.mock.calls[0][1];
    expect(update.$set.feature_permissions.agent_config).toBe("write");
    expect("__evil_feature" in update.$set.feature_permissions).toBe(false);
    expect(update.$set.feature_permissions.node_editor).toBe("none");
    expect(update.$set.updated_by).toBe("alice");
    // Legacy field should be unset.
    expect(update.$unset).toEqual({ permissions: "" });
  });

  it("upserts and reloads the cache", async () => {
    mockFind.mockResolvedValue([
      { _id: "viewer", feature_permissions: { ...SEED_DEFAULTS.viewer, billing: "read" } },
    ]);
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });
    await setRoleDefaults("viewer", { billing: "read" }, "alice");
    expect(mockUpdateOne.mock.calls[0][2]).toEqual({ upsert: true });
    expect(getCachedRoleDefaults("viewer").billing).toBe("read");
  });
});
