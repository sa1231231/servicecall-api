import { describe, it, expect } from "vitest";
import { buildDataChain, makeIdFactory, type PathIds, type PathPositions } from "../node-builders.js";
import type { DataPoint } from "../data-point-registry.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeDp(overrides: Partial<DataPoint>): DataPoint {
  return {
    label: "x",
    variableName: "x",
    type: "string",
    description: "desc",
    conversationPrompt: "ask",
    forwardCondition: "fwd",
    extractSuccessEquation: [],
    ...overrides,
  };
}

function makePathFixtures(count: number): { pathIds: PathIds; pathPos: PathPositions } {
  const f = makeIdFactory(1000);
  const chain = Array.from({ length: count }, () => ({
    convId: f.nodeId(),
    confirmId: f.nodeId(),
  }));
  const pathIds: PathIds = {
    transitionId: f.nodeId(),
    frontExtractId: f.nodeId(),
    routerId: f.nodeId(),
    chain,
    smsActions: [],
  };
  const zero = { x: 0, y: 0 };
  const pathPos: PathPositions = {
    transition: zero,
    frontExtract: zero,
    router: zero,
    chain: Array.from({ length: count }, () => ({ conv: zero, confirm: zero })),
    smsActions: [],
  };
  return { pathIds, pathPos };
}

function namesOf(node: Record<string, unknown>): string[] {
  const vars = node.variables as Array<{ name: string }> | undefined;
  return Array.isArray(vars) ? vars.map((v) => v.name) : [];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("buildDataChain — orphan variable persistence", () => {
  it("includes all dps in the front-loaded extract regardless of orphan flag", () => {
    const dps = [
      makeDp({ variableName: "orphan_a", label: "Orphan A", orphan: true }),
      makeDp({ variableName: "normal_b", label: "Normal B" }),
      makeDp({ variableName: "normal_c", label: "Normal C" }),
    ];
    const { pathIds, pathPos } = makePathFixtures(3);
    const f = makeIdFactory(2000);
    const nodes = buildDataChain(dps, pathIds, pathPos, "close-1", f) as Record<string, unknown>[];
    const front = nodes.find((n) => n.id === pathIds.frontExtractId);
    expect(front).toBeTruthy();
    expect(namesOf(front!)).toEqual(["orphan_a", "normal_b", "normal_c"]);
  });

  it("orphan vars persist in every Confirm extract; non-orphan vars taper", () => {
    // Layout: [orphan_a, normal_b, normal_c]
    //   Confirm at idx 0 → would be orphan_a's, but orphan dps don't get a
    //                       Collect/Confirm chain — so this index has no
    //                       Confirm node.
    //   Confirm at idx 1 (normal_b) → tapered = [normal_b, normal_c],
    //                                  + orphans = [orphan_a]
    //                                  → expect [normal_b, normal_c, orphan_a]
    //   Confirm at idx 2 (normal_c) → tapered = [normal_c],
    //                                  + orphans = [orphan_a]
    //                                  → expect [normal_c, orphan_a]
    const dps = [
      makeDp({ variableName: "orphan_a", label: "Orphan A", orphan: true }),
      makeDp({ variableName: "normal_b", label: "Normal B" }),
      makeDp({ variableName: "normal_c", label: "Normal C" }),
    ];
    const { pathIds, pathPos } = makePathFixtures(3);
    const f = makeIdFactory(3000);
    const nodes = buildDataChain(dps, pathIds, pathPos, "close-1", f) as Record<string, unknown>[];

    // Confirm for normal_b is at chain index 1 — its confirmId.
    const confirmB = nodes.find((n) => n.id === pathIds.chain[1].confirmId);
    expect(confirmB).toBeTruthy();
    expect(namesOf(confirmB!)).toEqual(["normal_b", "normal_c", "orphan_a"]);

    // Confirm for normal_c is at chain index 2.
    const confirmC = nodes.find((n) => n.id === pathIds.chain[2].confirmId);
    expect(confirmC).toBeTruthy();
    expect(namesOf(confirmC!)).toEqual(["normal_c", "orphan_a"]);

    // Orphan_a has no Collect/Confirm pair — index 0 should not produce one.
    const collectA = nodes.find((n) => n.id === pathIds.chain[0].convId);
    expect(collectA).toBeUndefined();
  });

  it("multiple orphan vars all persist in every Confirm extract", () => {
    const dps = [
      makeDp({ variableName: "orphan_a", label: "A", orphan: true }),
      makeDp({ variableName: "normal_b", label: "B" }),
      makeDp({ variableName: "orphan_c", label: "C", orphan: true }),
      makeDp({ variableName: "normal_d", label: "D" }),
    ];
    const { pathIds, pathPos } = makePathFixtures(4);
    const f = makeIdFactory(4000);
    const nodes = buildDataChain(dps, pathIds, pathPos, "close-1", f) as Record<string, unknown>[];

    // Confirm for normal_b (idx 1)
    const confirmB = nodes.find((n) => n.id === pathIds.chain[1].confirmId);
    // tapered = [normal_b, normal_d] (drops orphan_c since filtered),
    // + orphans = [orphan_a, orphan_c]
    expect(namesOf(confirmB!)).toEqual(["normal_b", "normal_d", "orphan_a", "orphan_c"]);

    // Confirm for normal_d (idx 3)
    const confirmD = nodes.find((n) => n.id === pathIds.chain[3].confirmId);
    expect(namesOf(confirmD!)).toEqual(["normal_d", "orphan_a", "orphan_c"]);
  });

  it("when there are no orphans, the tapered list matches the pre-fix behavior", () => {
    const dps = [
      makeDp({ variableName: "a", label: "A" }),
      makeDp({ variableName: "b", label: "B" }),
      makeDp({ variableName: "c", label: "C" }),
    ];
    const { pathIds, pathPos } = makePathFixtures(3);
    const f = makeIdFactory(5000);
    const nodes = buildDataChain(dps, pathIds, pathPos, "close-1", f) as Record<string, unknown>[];
    expect(namesOf(nodes.find((n) => n.id === pathIds.chain[0].confirmId)!)).toEqual(["a", "b", "c"]);
    expect(namesOf(nodes.find((n) => n.id === pathIds.chain[1].confirmId)!)).toEqual(["b", "c"]);
    expect(namesOf(nodes.find((n) => n.id === pathIds.chain[2].confirmId)!)).toEqual(["c"]);
  });
});
