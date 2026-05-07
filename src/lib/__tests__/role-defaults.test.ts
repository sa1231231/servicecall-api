import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FEATURE_KEYS,
  FEATURE_BY_KEY,
  ROLES,
  type Role,
  hasFeatureLevel,
  SEED_FEATURE_DEFAULTS,
} from "../feature-permissions.js";

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

// ── Round-trip: SEED defaults ↔ requireFeature middleware ──────────────────
//
// The role-management matrix the dashboard renders is derived from
// SEED_FEATURE_DEFAULTS (the per-role baseline, used until an admin
// stores a custom map). These tests pin the promises that matrix
// makes — that the seed for each role actually translates into the
// allow/deny behavior `requireFeature(...)` will produce when the
// session-auth layer copies the perms onto `req.user.featurePermissions`.

describe("seed defaults — generic round-trip", () => {
  // For every role × feature with a non-`none` seed level, the user
  // must be able to call `requireFeature(feature, seedLevel)` and pass.
  it.each(ROLES)("%s: every non-none seed level passes its own gate", (role: Role) => {
    const perms = SEED_FEATURE_DEFAULTS[role];
    for (const f of FEATURE_KEYS) {
      const lvl = perms[f];
      if (lvl === "none") continue;
      expect(
        hasFeatureLevel(perms, f, lvl),
        `${role} seed has ${f}:${lvl} but hasFeatureLevel said false`,
      ).toBe(true);
    }
  });

  // For every role × feature with a `none` seed level, every gate should reject.
  it.each(ROLES)("%s: `none`-seeded features reject every required level", (role: Role) => {
    const perms = SEED_FEATURE_DEFAULTS[role];
    for (const f of FEATURE_KEYS) {
      if (perms[f] !== "none") continue;
      expect(hasFeatureLevel(perms, f, "read")).toBe(false);
      expect(hasFeatureLevel(perms, f, "write")).toBe(false);
      expect(hasFeatureLevel(perms, f, "manage")).toBe(false);
    }
  });

  // The matrix should exhibit hierarchy: super_admin ≥ admin ≥ operator ≥ viewer
  // for every feature that's NOT marked super_admin-only. (super_admin-only
  // features are zeroed for admin/operator/viewer by design, which fits the
  // hierarchy trivially.)
  it("super_admin level >= admin level for every non-super-admin-only feature", () => {
    const sa = SEED_FEATURE_DEFAULTS.super_admin;
    const a = SEED_FEATURE_DEFAULTS.admin;
    const RANK = { none: 0, read: 1, write: 2, manage: 3 };
    for (const f of FEATURE_KEYS) {
      if (FEATURE_BY_KEY[f].superAdminOnly) continue;
      expect(
        RANK[sa[f]] >= RANK[a[f]],
        `${f}: super_admin=${sa[f]} should be >= admin=${a[f]}`,
      ).toBe(true);
    }
  });

  it("admin level >= operator level for every feature", () => {
    const a = SEED_FEATURE_DEFAULTS.admin;
    const o = SEED_FEATURE_DEFAULTS.operator;
    const RANK = { none: 0, read: 1, write: 2, manage: 3 };
    for (const f of FEATURE_KEYS) {
      expect(
        RANK[a[f]] >= RANK[o[f]],
        `${f}: admin=${a[f]} should be >= operator=${o[f]}`,
      ).toBe(true);
    }
  });

  it("operator level >= viewer level for every feature", () => {
    const o = SEED_FEATURE_DEFAULTS.operator;
    const v = SEED_FEATURE_DEFAULTS.viewer;
    const RANK = { none: 0, read: 1, write: 2, manage: 3 };
    for (const f of FEATURE_KEYS) {
      expect(
        RANK[o[f]] >= RANK[v[f]],
        `${f}: operator=${o[f]} should be >= viewer=${v[f]}`,
      ).toBe(true);
    }
  });
});

// ── Specific matrix promises (the security-critical pins) ─────────────────
//
// These are the assertions the matrix UI implies but the generic
// hierarchy tests above don't enforce. If any of these flips, an
// operator just lost a security boundary and we want to know.

describe("seed defaults — specific security pins", () => {
  it("viewer never has write or manage on any feature", () => {
    const v = SEED_FEATURE_DEFAULTS.viewer;
    for (const f of FEATURE_KEYS) {
      expect(
        v[f] === "none" || v[f] === "read",
        `viewer.${f}=${v[f]} — viewer should never have write/manage`,
      ).toBe(true);
    }
  });

  it("admin gets `none` on every super_admin-only feature", () => {
    const a = SEED_FEATURE_DEFAULTS.admin;
    for (const f of FEATURE_KEYS) {
      if (FEATURE_BY_KEY[f].superAdminOnly) {
        expect(a[f]).toBe("none");
      }
    }
  });

  it("operator can write to permanent_delete (restore) but cannot manage (permanent delete)", () => {
    const o = SEED_FEATURE_DEFAULTS.operator;
    expect(hasFeatureLevel(o, "permanent_delete", "write")).toBe(true);
    expect(hasFeatureLevel(o, "permanent_delete", "manage")).toBe(false);
  });

  it("operator cannot write to global_settings / sms_templates / data_point_defaults / audit_log / billing", () => {
    const o = SEED_FEATURE_DEFAULTS.operator;
    for (const f of ["global_settings", "sms_templates", "data_point_defaults", "audit_log", "billing"]) {
      // These features may be defined or not; only assert when they exist.
      if (!FEATURE_BY_KEY[f]) continue;
      expect(
        hasFeatureLevel(o, f, "write"),
        `operator.${f}=${o[f]} — operator should NOT have write here`,
      ).toBe(false);
    }
  });
});
