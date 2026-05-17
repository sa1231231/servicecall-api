import { describe, it, expect, vi } from "vitest";
import type { ParsedDataPoint, ParsedPath } from "../../../lib/node-parser.js";

// node-editor.ts imports config.ts (which calls requireEnv at load) and the
// Retell SDK. Mock both so the module imports cleanly — the helpers under
// test are pure and touch neither.
vi.mock("../../../config.js", () => ({
  config: { RETELL_API_KEY: "test", API_KEY: "test" },
}));
vi.mock("retell-sdk", () => ({ default: class {} }));

const { readNodeFinetunes, extractBranchConditions } = await import("../node-editor.js");

// ── readNodeFinetunes ────────────────────────────────────────────────────────

describe("readNodeFinetunes", () => {
  it("returns [] for an undefined node", () => {
    expect(readNodeFinetunes(undefined)).toEqual([]);
  });

  it("returns [] when the node has no finetune_transition_examples", () => {
    expect(readNodeFinetunes({ id: "n1" })).toEqual([]);
  });

  it("classifies an example with destination_node_id as positive", () => {
    const out = readNodeFinetunes({
      finetune_transition_examples: [
        { id: "fe1", destination_node_id: "node-x", transcript: [{ role: "user", content: "hi" }] },
      ],
    });
    expect(out).toEqual([
      {
        type: "positive",
        id: "fe1",
        destination: "node-x",
        transcript: [{ role: "user", content: "hi" }],
      },
    ]);
  });

  it("classifies an example with no destination_node_id as negative, omitting id/destination", () => {
    const out = readNodeFinetunes({
      finetune_transition_examples: [{ transcript: [{ role: "user", content: "nope" }] }],
    });
    expect(out).toEqual([{ type: "negative", transcript: [{ role: "user", content: "nope" }] }]);
    expect(out[0]).not.toHaveProperty("id");
    expect(out[0]).not.toHaveProperty("destination");
  });

  it("normalizes a mixed positive/negative list in order", () => {
    const out = readNodeFinetunes({
      finetune_transition_examples: [
        { id: "a", destination_node_id: "d1", transcript: [] },
        { id: "b", transcript: [] },
      ],
    });
    expect(out.map((e) => e.type)).toEqual(["positive", "negative"]);
  });
});

// ── extractBranchConditions ──────────────────────────────────────────────────

function makeDp(overrides: Partial<ParsedDataPoint> = {}): ParsedDataPoint {
  return {
    variableName: "problem_description",
    label: "Problem Description",
    collectNode: { raw: {}, id: "collect-pd", name: "Collect", type: "conversation" },
    confirmNode: { raw: {}, id: "confirm-pd", name: "Confirm", type: "extract_dynamic_variables" },
    variableDefs: [{ name: "problem_description", type: "string", description: "" }],
    conversationPrompt: "",
    forwardCondition: "",
    ...overrides,
  };
}

function pathWithRouterEdges(edges: Array<Record<string, unknown>>): ParsedPath {
  return {
    name: "service_call",
    transitionNode: { raw: {}, id: "t1", name: "Transition", type: "conversation" },
    frontExtractNode: { raw: {}, id: "fe1", name: "Front", type: "extract_dynamic_variables" },
    routerNode: { raw: { edges }, id: "router-1", name: "Variables Router", type: "branch" },
    dataChain: [],
    smsActions: [],
    steps: [],
    endMode: "callback",
  } as ParsedPath;
}

describe("extractBranchConditions", () => {
  it("returns undefined when no router edge targets the data point's Collect node", () => {
    const path = pathWithRouterEdges([
      { destination_node_id: "some-other-node", transition_condition: { type: "equation", equations: [] } },
    ]);
    expect(extractBranchConditions(makeDp(), [path])).toBeUndefined();
  });

  it("returns undefined when the router edge condition is not an equation", () => {
    const path = pathWithRouterEdges([
      { destination_node_id: "collect-pd", transition_condition: { type: "prompt", prompt: "..." } },
    ]);
    expect(extractBranchConditions(makeDp(), [path])).toBeUndefined();
  });

  it("returns undefined when equations are only the standard is-missing checks", () => {
    const path = pathWithRouterEdges([
      {
        destination_node_id: "collect-pd",
        transition_condition: {
          type: "equation",
          equations: [
            { left: "{{problem_description}}", operator: "==", right: "Not Mentioned" },
            { left: "{{phone_number_collected}}", operator: "==", right: "true" },
          ],
        },
      },
    ]);
    expect(extractBranchConditions(makeDp(), [path])).toBeUndefined();
  });

  it("extracts a genuine branch condition, dropping the is-missing check", () => {
    const path = pathWithRouterEdges([
      {
        destination_node_id: "collect-pd",
        transition_condition: {
          type: "equation",
          equations: [
            { left: "{{problem_description}}", operator: "==", right: "Not Mentioned" },
            { left: "{{service_type}}", operator: "==", right: "emergency" },
          ],
        },
      },
    ]);
    expect(extractBranchConditions(makeDp(), [path])).toEqual([
      { variable: "service_type", operator: "==", value: "emergency" },
    ]);
  });

  it("drops equations on the data point's composite sub-variables", () => {
    const dp = makeDp({
      variableName: "scheduling",
      variableDefs: [
        { name: "preferred_day", type: "string", description: "" },
        { name: "preferred_time", type: "string", description: "" },
      ],
    });
    const path = pathWithRouterEdges([
      {
        destination_node_id: "collect-pd",
        transition_condition: {
          type: "equation",
          equations: [
            { left: "{{preferred_day}}", operator: "==", right: "Not Mentioned" },
            { left: "{{urgency}}", operator: "==", right: "high" },
          ],
        },
      },
    ]);
    expect(extractBranchConditions(dp, [path])).toEqual([
      { variable: "urgency", operator: "==", value: "high" },
    ]);
  });

  it("finds the router edge across multiple paths", () => {
    const otherPath = pathWithRouterEdges([{ destination_node_id: "unrelated" }]);
    const target = pathWithRouterEdges([
      {
        destination_node_id: "collect-pd",
        transition_condition: {
          type: "equation",
          equations: [{ left: "{{urgency}}", operator: "!=", right: "low" }],
        },
      },
    ]);
    expect(extractBranchConditions(makeDp(), [otherPath, target])).toEqual([
      { variable: "urgency", operator: "!=", value: "low" },
    ]);
  });
});
