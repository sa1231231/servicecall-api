import { describe, it, expect } from "vitest";
import { ruleToFunction, toClientConfig } from "../client-store.js";
import type { JsonClientEntry, ResolveRule, ResolveRuleEntry } from "../client-store.js";

// ── ruleToFunction ──────────────────────────────────────────────────────────

describe("ruleToFunction", () => {
  it("returns defaultType when no rules provided", () => {
    const fn = ruleToFunction(undefined, undefined, "fallback");
    expect(fn({})).toBe("fallback");
    expect(fn({ anything: "value" })).toBe("fallback");
  });

  it("resolves binary rule — then branch", () => {
    const rule: ResolveRule = {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    };
    const fn = ruleToFunction(rule, undefined, "service_request");
    expect(fn({ is_emergency: "true" })).toBe("emergency");
  });

  it("resolves binary rule — else branch", () => {
    const rule: ResolveRule = {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    };
    const fn = ruleToFunction(rule, undefined, "service_request");
    expect(fn({ is_emergency: "false" })).toBe("service_request");
    expect(fn({})).toBe("service_request");
  });

  it("resolves multi-path rules — first match wins", () => {
    const rules: ResolveRuleEntry[] = [
      { field: "path", equals: "Residential", then: "residential" },
      { field: "path", equals: "Commercial", then: "commercial" },
    ];
    const fn = ruleToFunction(undefined, rules, "default");
    expect(fn({ path: "Residential" })).toBe("residential");
    expect(fn({ path: "Commercial" })).toBe("commercial");
  });

  it("returns defaultType when no multi-path rule matches", () => {
    const rules: ResolveRuleEntry[] = [
      { field: "path", equals: "Residential", then: "residential" },
    ];
    const fn = ruleToFunction(undefined, rules, "default");
    expect(fn({ path: "Other" })).toBe("default");
    expect(fn({})).toBe("default");
  });

  it("multi-path rules take precedence over binary rule", () => {
    const rule: ResolveRule = {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    };
    const rules: ResolveRuleEntry[] = [
      { field: "path", equals: "VIP", then: "vip" },
    ];
    const fn = ruleToFunction(rule, rules, "default");
    // Multi-path should win
    expect(fn({ path: "VIP" })).toBe("vip");
    // Binary rule ignored when multi-path rules exist
    expect(fn({ is_emergency: "true" })).toBe("default");
  });
});

// ── toClientConfig ──────────────────────────────────────────────────────────

describe("toClientConfig", () => {
  function makeEntry(overrides: Partial<JsonClientEntry> = {}): JsonClientEntry {
    return {
      name: "Test Co",
      agent_ids: ["agent_1"],
      dispatch_text_numbers: ["+15551234567"],
      dispatch_call_number: null,
      summary_agent_id: null,
      outbound_from_number: null,
      dispatch_email: ["test@test.com"],
      dispatch_cc: null,
      message_types: {
        service_request: {
          label: "SR",
          subject_template: "SR",
          fields: [{ key: "name", label: "Name" }],
        },
      },
      default_message_type: "service_request",
      ...overrides,
    };
  }

  it("converts entry to config with resolve_type function", () => {
    const config = toClientConfig(makeEntry());
    expect(typeof config.resolve_type).toBe("function");
    expect(config.resolve_type({})).toBe("service_request");
  });

  it("passes through all dispatch fields", () => {
    const entry = makeEntry({
      dispatch_email: ["a@b.com", "c@d.com"],
      dispatch_cc: "cc@test.com",
      dispatch_call_number: "+15559999999",
    });
    const config = toClientConfig(entry);
    expect(config.dispatch_email).toEqual(["a@b.com", "c@d.com"]);
    expect(config.dispatch_cc).toBe("cc@test.com");
    expect(config.dispatch_call_number).toBe("+15559999999");
  });

  it("preserves shadow_mode", () => {
    expect(toClientConfig(makeEntry({ shadow_mode: true })).shadow_mode).toBe(true);
    expect(toClientConfig(makeEntry({ shadow_mode: false })).shadow_mode).toBe(false);
    expect(toClientConfig(makeEntry()).shadow_mode).toBeUndefined();
  });

  it("wires up binary resolve_rule", () => {
    const config = toClientConfig(
      makeEntry({
        resolve_rule: {
          field: "is_emergency",
          equals: "true",
          then: "emergency",
          else: "service_request",
        },
      }),
    );
    expect(config.resolve_type({ is_emergency: "true" })).toBe("emergency");
    expect(config.resolve_type({ is_emergency: "false" })).toBe("service_request");
  });

  it("wires up multi-path resolve_rules", () => {
    const config = toClientConfig(
      makeEntry({
        resolve_rules: [
          { field: "type", equals: "A", then: "type_a" },
          { field: "type", equals: "B", then: "type_b" },
        ],
      }),
    );
    expect(config.resolve_type({ type: "A" })).toBe("type_a");
    expect(config.resolve_type({ type: "B" })).toBe("type_b");
    expect(config.resolve_type({})).toBe("service_request");
  });

  it("passes through dispatch_by_type when present", () => {
    const byType = {
      automotive: {
        dispatch_text_numbers: ["+15559999999"],
        dispatch_email: ["auto@test.com"],
      },
    };
    const config = toClientConfig(makeEntry({ dispatch_by_type: byType }));
    expect(config.dispatch_by_type).toEqual(byType);
  });

  it("dispatch_by_type is undefined when not set", () => {
    const config = toClientConfig(makeEntry());
    expect(config.dispatch_by_type).toBeUndefined();
  });
});
