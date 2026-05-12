import { describe, it, expect } from "vitest";
import { parseAcceptance } from "../grader.js";

// Locks in the response-parser for Pass B (acceptance criteria). The
// grader's LLM call goes out over the network during live runs and isn't
// tested here — but a stray code fence or off-shape JSON shouldn't be
// allowed to corrupt the report aggregations.

describe("parseAcceptance", () => {
  const criteria = [
    "Agent acknowledged the stressful situation",
    "Agent did not promise a specific ETA",
  ];

  it("parses well-formed results, preserving order", () => {
    const raw = JSON.stringify({
      results: [
        { criterion: criteria[0], verdict: "met", reason: "said 'sounds urgent' early" },
        { criterion: criteria[1], verdict: "not_met", reason: "promised 30 minutes" },
      ],
    });
    const { results, error } = parseAcceptance(raw, criteria);
    expect(error).toBeUndefined();
    expect(results).toHaveLength(2);
    expect(results[0].verdict).toBe("met");
    expect(results[1].verdict).toBe("not_met");
  });

  it("recovers from out-of-order results via text match", () => {
    const raw = JSON.stringify({
      results: [
        { criterion: criteria[1], verdict: "partial", reason: "vague time hint" },
        { criterion: criteria[0], verdict: "met", reason: "acknowledged" },
      ],
    });
    const { results } = parseAcceptance(raw, criteria);
    expect(results[0].criterion).toBe(criteria[0]);
    expect(results[0].verdict).toBe("met");
    expect(results[1].criterion).toBe(criteria[1]);
    expect(results[1].verdict).toBe("partial");
  });

  it("returns 'unknown' for invalid verdict values", () => {
    const raw = JSON.stringify({
      results: [
        { criterion: criteria[0], verdict: "kind-of", reason: "?" },
        { criterion: criteria[1], verdict: "met", reason: "ok" },
      ],
    });
    const { results } = parseAcceptance(raw, criteria);
    expect(results[0].verdict).toBe("unknown");
    expect(results[1].verdict).toBe("met");
  });

  it("returns 'unknown' for missing entries", () => {
    const raw = JSON.stringify({
      results: [{ criterion: criteria[0], verdict: "met", reason: "ok" }],
    });
    const { results } = parseAcceptance(raw, criteria);
    expect(results).toHaveLength(2);
    expect(results[0].verdict).toBe("met");
    expect(results[1].verdict).toBe("unknown");
    expect(results[1].reason).toMatch(/missing/i);
  });

  it("returns error and all-unknown when payload is not JSON", () => {
    const { results, error } = parseAcceptance("not json", criteria);
    expect(error).toBeDefined();
    expect(results.every((r) => r.verdict === "unknown")).toBe(true);
  });

  it("returns error when results array is missing", () => {
    const { results, error } = parseAcceptance(JSON.stringify({ foo: "bar" }), criteria);
    expect(error).toBeDefined();
    expect(results.every((r) => r.verdict === "unknown")).toBe(true);
  });

  it("strips code fences", () => {
    const raw = '```json\n' + JSON.stringify({
      results: criteria.map((c) => ({ criterion: c, verdict: "met", reason: "ok" })),
    }) + '\n```';
    const { results, error } = parseAcceptance(raw, criteria);
    expect(error).toBeUndefined();
    expect(results.every((r) => r.verdict === "met")).toBe(true);
  });
});
