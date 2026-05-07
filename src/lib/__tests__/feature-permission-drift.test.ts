import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { FEATURE_KEYS } from "../feature-permissions.js";

// Drift guard: every `requireFeature("foo", "level")` call site in the
// codebase must reference an actual key in FEATURE_KEYS and a valid
// Level. Catches typos like `requireFeature("agent_confgi", "write")`
// that would otherwise silently 403 forever — there's no runtime check.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "../../");
const VALID_LEVELS = new Set(["none", "read", "write", "manage"]);

// Match `requireFeature("…", "…")` allowing single or double quotes and
// arbitrary whitespace between args. We deliberately stick to a simple
// regex (no parser): the call shape is consistent across the codebase
// and a parser would be overkill for ~36 call sites.
const REQUIRE_FEATURE_RE = /requireFeature\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g;

interface Call {
  file: string;
  feature: string;
  level: string;
}

function listSourceFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir)) {
      // Skip generated, vendored, and test trees — only check production source.
      if (entry === "node_modules" || entry === "__tests__" || entry === "_fixtures" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) out.push(full);
    }
  }
  walk(SRC_ROOT);
  return out;
}

function collectCalls(): Call[] {
  const calls: Call[] = [];
  for (const file of listSourceFiles()) {
    const content = fs.readFileSync(file, "utf8");
    REQUIRE_FEATURE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REQUIRE_FEATURE_RE.exec(content)) !== null) {
      calls.push({
        file: path.relative(SRC_ROOT, file),
        feature: m[1],
        level: m[2],
      });
    }
  }
  return calls;
}

describe("requireFeature drift guard (production source)", () => {
  const calls = collectCalls();

  // Sanity: if this drops to zero, the regex broke or someone migrated
  // away from requireFeature without updating the test.
  it("finds at least 10 requireFeature() call sites in production source", () => {
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it("every feature argument is in FEATURE_KEYS", () => {
    const known = new Set<string>(FEATURE_KEYS);
    const unknown = calls.filter((c) => !known.has(c.feature));
    const lines = unknown.map(
      (c) => `  ${c.file}  requireFeature("${c.feature}", "${c.level}")`,
    );
    expect(
      unknown,
      lines.length > 0
        ? `\nrequireFeature(...) referenced unknown feature keys (typo?):\n${lines.join("\n")}\n` +
            `\nKnown feature keys: ${FEATURE_KEYS.join(", ")}`
        : "",
    ).toEqual([]);
  });

  it("every level argument is a valid Level (none|read|write|manage)", () => {
    const invalid = calls.filter((c) => !VALID_LEVELS.has(c.level));
    const lines = invalid.map(
      (c) => `  ${c.file}  requireFeature("${c.feature}", "${c.level}")`,
    );
    expect(
      invalid,
      lines.length > 0
        ? `\nrequireFeature(...) used invalid level argument:\n${lines.join("\n")}`
        : "",
    ).toEqual([]);
  });

  it("`none` is never used as a required level (would be a no-op gate)", () => {
    // requireFeature(_, "none") would let everyone through — almost
    // certainly a copy-paste bug.
    const noneGates = calls.filter((c) => c.level === "none");
    expect(noneGates).toEqual([]);
  });
});
