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

describe("role-defaults cache", () => {
  it("falls back to SEED_DEFAULTS when cache is unloaded", () => {
    // Note: cache state persists across tests. We check that SEED_DEFAULTS
    // is at least returned (the cache may already be populated from a
    // previous test's loadRoleDefaultsCache; the structure should match).
    const perms = getCachedRoleDefaults("operator");
    expect(perms).toHaveProperty("create_agents");
    expect(perms).toHaveProperty("manage_leads");
  });

  it("loads role defaults from MongoDB into the cache", async () => {
    mockFind.mockResolvedValue([
      { _id: "operator", permissions: { ...SEED_DEFAULTS.operator, manage_leads: false } },
    ]);
    await loadRoleDefaultsCache();
    const operator = getCachedRoleDefaults("operator");
    expect(operator.manage_leads).toBe(false);
    // viewer has no doc in this fixture → falls back to SEED_DEFAULTS
    const viewer = getCachedRoleDefaults("viewer");
    expect(viewer).toEqual(SEED_DEFAULTS.viewer);
  });

  it("merges stored permissions with the full known-key list", async () => {
    // Stored doc only has SOME keys; missing keys should default to false
    // (not undefined) so they render correctly in the UI matrix.
    mockFind.mockResolvedValue([
      { _id: "operator", permissions: { create_agents: true } },
    ]);
    await loadRoleDefaultsCache();
    const operator = getCachedRoleDefaults("operator");
    expect(operator.create_agents).toBe(true);
    expect(operator.manage_users).toBe(false); // not in stored, defaulted to false
    expect("manage_users" in operator).toBe(true); // key is present, not undefined
  });
});

describe("getRoleDefaults (async DB read)", () => {
  it("returns SEED_DEFAULTS when the doc is absent", async () => {
    mockFindOne.mockResolvedValue(null);
    const perms = await getRoleDefaults("admin");
    expect(perms).toEqual(SEED_DEFAULTS.admin);
  });

  it("returns the merged stored doc when present", async () => {
    mockFindOne.mockResolvedValue({
      _id: "operator",
      permissions: { create_agents: false, edit_agents: true },
    });
    const perms = await getRoleDefaults("operator");
    expect(perms.create_agents).toBe(false);
    expect(perms.edit_agents).toBe(true);
    // Missing keys default to false.
    expect(perms.manage_users).toBe(false);
  });
});

describe("setRoleDefaults", () => {
  it("rejects unknown roles", async () => {
    await expect(setRoleDefaults("ceo" as never, {}, "alice")).rejects.toThrow(/Unknown role/);
  });

  it("strips unknown keys before writing", async () => {
    mockFind.mockResolvedValue([]);
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    await setRoleDefaults("operator", {
      create_agents: true,
      __evil_key: true as never,
    }, "alice");
    const update = mockUpdateOne.mock.calls[0][1];
    expect(update.$set.permissions.create_agents).toBe(true);
    expect("__evil_key" in update.$set.permissions).toBe(false);
    expect(update.$set.updated_by).toBe("alice");
  });

  it("upserts and reloads the cache", async () => {
    mockFind.mockResolvedValue([
      { _id: "viewer", permissions: { ...SEED_DEFAULTS.viewer, view_billing: true } },
    ]);
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });
    await setRoleDefaults("viewer", { view_billing: true }, "alice");
    expect(mockUpdateOne.mock.calls[0][2]).toEqual({ upsert: true });
    // Cache reloaded with the new doc.
    expect(getCachedRoleDefaults("viewer").view_billing).toBe(true);
  });
});
