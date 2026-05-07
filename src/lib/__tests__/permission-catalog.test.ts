// Drift guard: ensures PERMISSION_CATALOG stays in sync with the
// permission keys defined in users.ts. If a future PR adds a permission
// to PERMISSION_DEFS without documenting it here (or vice versa), this
// test fails and forces the catalog to be updated.

import { describe, it, expect } from "vitest";
import { PERMISSION_DEFS } from "../users.js";
import { PERMISSION_CATALOG, PERMISSION_CATALOG_BY_KEY } from "../permission-catalog.js";

describe("permission catalog", () => {
  it("documents every key in PERMISSION_DEFS", () => {
    const missing: string[] = [];
    for (const def of PERMISSION_DEFS) {
      if (!PERMISSION_CATALOG_BY_KEY[def.key]) {
        missing.push(def.key);
      }
    }
    expect(missing, `Add these keys to permission-catalog.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not document any keys that aren't in PERMISSION_DEFS", () => {
    const knownKeys = new Set(PERMISSION_DEFS.map((d) => d.key));
    const stale = PERMISSION_CATALOG
      .map((p) => p.key)
      .filter((k) => !knownKeys.has(k));
    expect(stale, `Remove these stale keys from permission-catalog.ts: ${stale.join(", ")}`).toEqual([]);
  });

  it("each entry has at least one route OR ui element", () => {
    for (const entry of PERMISSION_CATALOG) {
      const hasContent = entry.routes.length > 0 || entry.ui.length > 0;
      expect(hasContent, `Permission "${entry.key}" has no routes or ui — what does it gate?`).toBe(true);
    }
  });

  it("has no duplicate keys", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const entry of PERMISSION_CATALOG) {
      if (seen.has(entry.key)) dupes.push(entry.key);
      seen.add(entry.key);
    }
    expect(dupes).toEqual([]);
  });
});
