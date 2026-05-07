import { describe, it, expect } from "vitest";
import {
  satisfies,
  hasFeatureLevel,
  migrateOldPermissionsToFeatureLevels,
  resolveFeaturePermissions,
  SEED_FEATURE_DEFAULTS,
  FEATURE_KEYS,
} from "../feature-permissions.js";

describe("level rank semantics", () => {
  it("manage > write > read > none", () => {
    expect(satisfies("manage", "read")).toBe(true);
    expect(satisfies("manage", "write")).toBe(true);
    expect(satisfies("manage", "manage")).toBe(true);
    expect(satisfies("write", "manage")).toBe(false);
    expect(satisfies("write", "write")).toBe(true);
    expect(satisfies("read", "write")).toBe(false);
    expect(satisfies("none", "read")).toBe(false);
    expect(satisfies(undefined, "read")).toBe(false);
  });

  it("hasFeatureLevel reads from a permission map", () => {
    const perms = { agent_config: "write" as const, billing: "read" as const };
    expect(hasFeatureLevel(perms, "agent_config", "read")).toBe(true);
    expect(hasFeatureLevel(perms, "agent_config", "write")).toBe(true);
    expect(hasFeatureLevel(perms, "agent_config", "manage")).toBe(false);
    expect(hasFeatureLevel(perms, "billing", "write")).toBe(false);
    expect(hasFeatureLevel(perms, "users", "read")).toBe(false);
  });
});

describe("seed defaults", () => {
  it("super_admin gets the highest level for every feature", () => {
    for (const f of FEATURE_KEYS) {
      const lvl = SEED_FEATURE_DEFAULTS.super_admin[f];
      expect(["read", "write", "manage"]).toContain(lvl);
    }
  });

  it("admin does NOT get superAdminOnly features by default", () => {
    expect(SEED_FEATURE_DEFAULTS.admin.users).toBe("none");
    expect(SEED_FEATURE_DEFAULTS.admin.role_defaults).toBe("none");
  });

  it("viewer gets at most read across the board", () => {
    for (const f of FEATURE_KEYS) {
      const lvl = SEED_FEATURE_DEFAULTS.viewer[f];
      expect(["none", "read"]).toContain(lvl);
    }
  });

  it("operator can use Pending Leads + send comms by default", () => {
    expect(SEED_FEATURE_DEFAULTS.operator.pending_leads).toBe("write");
    expect(SEED_FEATURE_DEFAULTS.operator.send_comms).toBe("write");
  });
});

describe("migrateOldPermissionsToFeatureLevels", () => {
  it("preserves a doc that's already in the new shape", () => {
    const input = { agent_config: "write", users: "manage" } as unknown as Record<string, boolean>;
    const out = migrateOldPermissionsToFeatureLevels(input);
    expect(out).toEqual({ agent_config: "write", users: "manage" });
  });

  it("maps edit_agents=true to agent_config:write + node_editor:write + folders:write", () => {
    const out = migrateOldPermissionsToFeatureLevels({ edit_agents: true }, "operator");
    expect(out.agent_config).toBe("write");
    expect(out.node_editor).toBe("write");
    expect(out.folders).toBe("write");
  });

  it("maps delete_agents=true to agent_lifecycle:manage", () => {
    const out = migrateOldPermissionsToFeatureLevels({ delete_agents: true }, "operator");
    expect(out.agent_lifecycle).toBe("manage");
  });

  it("clamps with explicit false overrides (manage_leads=false → pending_leads:none)", () => {
    const out = migrateOldPermissionsToFeatureLevels({ manage_leads: false }, "operator");
    expect(out.pending_leads).toBe("none");
  });

  it("falls back to seed defaults when input is null/empty", () => {
    expect(migrateOldPermissionsToFeatureLevels(null, "operator")).toEqual(SEED_FEATURE_DEFAULTS.operator);
    expect(migrateOldPermissionsToFeatureLevels({}, "viewer")).toEqual(SEED_FEATURE_DEFAULTS.viewer);
  });
});

describe("resolveFeaturePermissions", () => {
  it("super_admin / admin: stored is ignored, defaults are authoritative", () => {
    const defaults = { agent_config: "write" as const };
    expect(resolveFeaturePermissions("super_admin", defaults, { agent_config: "none" })).toEqual(defaults);
    expect(resolveFeaturePermissions("admin", defaults, { agent_config: "none" })).toEqual(defaults);
  });

  it("operator / viewer: stored overrides specific features", () => {
    const defaults = { agent_config: "write" as const, billing: "none" as const };
    const stored = { billing: "read" as const };
    expect(resolveFeaturePermissions("operator", defaults, stored).billing).toBe("read");
    expect(resolveFeaturePermissions("operator", defaults, stored).agent_config).toBe("write");
  });
});
