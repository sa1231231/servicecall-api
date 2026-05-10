import { describe, it, expect } from "vitest";
import { regenerateDataChain, applyRegeneratedChain } from "../node-regenerator.js";
import { parseConversationFlow, type ParsedPath } from "../node-parser.js";
import type { DataPoint } from "../agent-generator/data-point-registry.js";

// ── Fixture builder ─────────────────────────────────────────────────────────
// Build a minimal canonical JSON with a single parseable path containing
// `vars` data points, then parse it back to a ParsedPath. This mirrors the
// real upstream pipeline (canonical JSON → parser → regenerator).

function dp(overrides: Partial<DataPoint>): DataPoint {
  return {
    label: "X",
    variableName: "x",
    type: "string",
    description: "desc",
    conversationPrompt: "Ask for x",
    forwardCondition: "got x",
    extractSuccessEquation: [],
    ...overrides,
  };
}

function buildFlow(vars: Array<{ id: string; name: string }>): Record<string, unknown> {
  const collectIds = vars.map((v) => `collect-${v.id}`);
  const confirmIds = vars.map((v) => `confirm-${v.id}`);

  const nodes: any[] = [
    { id: "intro", type: "conversation", name: "Intro", instruction: { type: "prompt", text: "hi" }, edges: [] },
    {
      id: "transition",
      type: "conversation",
      name: "Transition (p)",
      skip_response_edge: { destination_node_id: "extract" },
    },
    {
      id: "extract",
      type: "extract_dynamic_variables",
      name: "Extract All Variables (p)",
      variables: vars.map((v) => ({ name: v.name, type: "string", description: "" })),
      else_edge: { destination_node_id: "router" },
    },
    {
      id: "router",
      type: "branch",
      name: "Variables Router (p)",
      edges: vars.map((v, i) => ({
        destination_node_id: collectIds[i],
        transition_condition: { type: "equation", equations: [] },
      })),
      else_edge: { destination_node_id: "close" },
    },
  ];
  vars.forEach((v, i) => {
    nodes.push({
      id: collectIds[i],
      type: "conversation",
      name: `Collect ${v.name}`,
      instruction: { type: "prompt", text: `Ask for ${v.name}` },
      edges: [
        {
          destination_node_id: confirmIds[i],
          transition_condition: { type: "prompt", prompt: `Got ${v.name}` },
        },
      ],
    });
    nodes.push({
      id: confirmIds[i],
      type: "extract_dynamic_variables",
      name: `Confirm ${v.name}`,
      variables: [{ name: v.name, type: "string", description: "" }],
    });
  });
  nodes.push({ id: "close", type: "conversation", name: "Close", instruction: { type: "prompt", text: "bye" } });

  return {
    conversationFlow: {
      start_node_id: "intro",
      global_prompt: "global",
      nodes,
    },
  };
}

function pathFor(flow: Record<string, unknown>): ParsedPath {
  const parsed = parseConversationFlow(flow);
  if (parsed.paths.length === 0) throw new Error("No parsed paths in fixture");
  return parsed.paths[0];
}

function namesOf(node: Record<string, unknown>): string[] {
  const vars = node.variables as Array<{ name: string }> | undefined;
  return Array.isArray(vars) ? vars.map((v) => v.name) : [];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("regenerateDataChain", () => {
  it("preserves existing collect/confirm node IDs when variableName is unchanged", () => {
    const flow = buildFlow([
      { id: "1", name: "first_name" },
      { id: "2", name: "last_name" },
    ]);
    const path = pathFor(flow);
    const dps = [
      dp({ variableName: "first_name", label: "First Name" }),
      dp({ variableName: "last_name", label: "Last Name" }),
    ];

    const { newNodes } = regenerateDataChain(path, dps, "close", "p");

    const collectFirst = newNodes.find((n) => n.name === "Collect First Name");
    const collectLast = newNodes.find((n) => n.name === "Collect Last Name");
    expect(collectFirst?.id).toBe("collect-1");
    expect(collectLast?.id).toBe("collect-2");
  });

  it("preserves the front-extract and router IDs", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "first_name", label: "First Name" })];

    const { newNodes } = regenerateDataChain(path, dps, "close", "p");

    const front = newNodes.find((n) => n.id === "extract");
    const router = newNodes.find((n) => n.id === "router");
    expect(front?.type).toBe("extract_dynamic_variables");
    expect(router?.type).toBe("branch");
  });

  it("front-extract lists all data point variables in order", () => {
    const flow = buildFlow([
      { id: "1", name: "first_name" },
      { id: "2", name: "last_name" },
    ]);
    const path = pathFor(flow);
    const dps = [
      dp({ variableName: "first_name", label: "First Name" }),
      dp({ variableName: "last_name", label: "Last Name" }),
      dp({ variableName: "email", label: "Email" }),
    ];

    const { newNodes } = regenerateDataChain(path, dps, "close", "p");
    const front = newNodes.find((n) => n.id === "extract")!;
    expect(namesOf(front)).toEqual(["first_name", "last_name", "email", "_path_taken"]);
  });

  it("appends _path_taken to front-extract only when pathName is given", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "first_name", label: "First Name" })];

    const withName = regenerateDataChain(path, dps, "close", "p");
    const withoutName = regenerateDataChain(path, dps, "close");

    expect(namesOf(withName.newNodes.find((n) => n.id === "extract")!)).toContain("_path_taken");
    expect(namesOf(withoutName.newNodes.find((n) => n.id === "extract")!)).not.toContain("_path_taken");
  });

  it("router has one edge per non-orphan data point + an else_edge", () => {
    const flow = buildFlow([
      { id: "1", name: "first_name" },
      { id: "2", name: "last_name" },
    ]);
    const path = pathFor(flow);
    const dps = [
      dp({ variableName: "first_name", label: "First Name" }),
      dp({ variableName: "last_name", label: "Last Name" }),
      dp({ variableName: "passive_signal", label: "Passive", orphan: true }),
    ];

    const { newNodes } = regenerateDataChain(path, dps, "close", "p");
    const router = newNodes.find((n) => n.id === "router") as any;

    expect(router.edges).toHaveLength(2); // orphan does NOT get a router edge
    expect(router.else_edge.destination_node_id).toBe("close");
  });

  it("router else_edge points to the close node in callback mode", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    expect(path.endMode).toBe("callback");

    const { newNodes } = regenerateDataChain(path, [dp({ variableName: "first_name", label: "First Name" })], "close", "p");
    const router = newNodes.find((n) => n.id === "router") as any;
    expect(router.else_edge.destination_node_id).toBe("close");
  });

  it("orphan data points get NO Collect/Confirm nodes", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    const dps = [
      dp({ variableName: "first_name", label: "First Name" }),
      dp({ variableName: "passive_signal", label: "Passive", orphan: true }),
    ];

    const { newNodes } = regenerateDataChain(path, dps, "close", "p");
    expect(newNodes.find((n) => n.name === "Collect Passive")).toBeUndefined();
    expect(newNodes.find((n) => n.name === "Confirm Passive")).toBeUndefined();
    expect(newNodes.find((n) => n.name === "Collect First Name")).toBeDefined();
  });

  it("preserves existing conversationPrompt on collect node (Retell console tweaks)", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    // Simulate a console-edited prompt
    const collectNode = (flow.conversationFlow as any).nodes.find((n: any) => n.id === "collect-1");
    collectNode.instruction.text = "CUSTOM PROMPT EDITED IN CONSOLE";
    const path = pathFor(flow);

    // The dp passed in has a different conversationPrompt — regenerator should
    // NOT clobber the existing one.
    const dps = [dp({ variableName: "first_name", label: "First Name", conversationPrompt: "Generic ask" })];
    const { newNodes } = regenerateDataChain(path, dps, "close", "p");
    const collect = newNodes.find((n) => n.name === "Collect First Name") as any;
    expect(collect.instruction.text).toBe("CUSTOM PROMPT EDITED IN CONSOLE");
  });

  it("removedNodeIds includes front-extract, router, and every collect/confirm in the existing path", () => {
    const flow = buildFlow([
      { id: "1", name: "first_name" },
      { id: "2", name: "last_name" },
    ]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "first_name", label: "First Name" })];

    const { removedNodeIds } = regenerateDataChain(path, dps, "close", "p");
    expect(removedNodeIds.has("extract")).toBe(true);
    expect(removedNodeIds.has("router")).toBe(true);
    expect(removedNodeIds.has("collect-1")).toBe(true);
    expect(removedNodeIds.has("confirm-1")).toBe(true);
    expect(removedNodeIds.has("collect-2")).toBe(true);
    expect(removedNodeIds.has("confirm-2")).toBe(true);
  });

  it("phone_number adds the phone_collected flag to the Confirm node's variable list", () => {
    const flow = buildFlow([{ id: "1", name: "phone_number" }]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "phone_number", label: "Phone Number" })];

    const { newNodes } = regenerateDataChain(path, dps, "close", "p");
    const confirm = newNodes.find((n) => n.name === "Confirm Phone Number") as any;
    expect(namesOf(confirm)).toContain("phone_number_collected");
  });

  it("phone_number router edge uses && operator and checks the collected flag", () => {
    const flow = buildFlow([{ id: "1", name: "phone_number" }]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "phone_number", label: "Phone Number" })];

    const { newNodes } = regenerateDataChain(path, dps, "close", "p");
    const router = newNodes.find((n) => n.id === "router") as any;
    const tc = router.edges[0].transition_condition;
    expect(tc.operator).toBe("&&");
    const eqs = tc.equations as Array<{ left: string; operator: string; right?: string }>;
    expect(eqs.some((e) => e.left.includes("phone_number_collected") && e.operator === "!=")).toBe(true);
  });
});

// ── applyRegeneratedChain ───────────────────────────────────────────────────

describe("applyRegeneratedChain", () => {
  it("removes old chain nodes and adds the new ones in place", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    const dps = [
      dp({ variableName: "first_name", label: "First Name" }),
      dp({ variableName: "email", label: "Email" }),
    ];
    const result = regenerateDataChain(path, dps, "close", "p");

    applyRegeneratedChain(flow, result);

    const nodes = (flow.conversationFlow as any).nodes as any[];
    // New collect/confirm for "Email" added; intro/transition/close untouched
    expect(nodes.some((n) => n.name === "Collect Email")).toBe(true);
    expect(nodes.some((n) => n.id === "intro")).toBe(true);
    expect(nodes.some((n) => n.id === "transition")).toBe(true);
    expect(nodes.some((n) => n.id === "close")).toBe(true);
    // Stale collect-1/confirm-1 should be replaced (same ID reused), not duplicated
    const collectIds = nodes.filter((n) => n.id === "collect-1");
    expect(collectIds).toHaveLength(1);
  });

  it("guarantees no duplicate node ids after applying the chain", () => {
    const flow = buildFlow([
      { id: "1", name: "first_name" },
      { id: "2", name: "last_name" },
    ]);
    const path = pathFor(flow);
    const dps = [
      dp({ variableName: "first_name", label: "First Name" }),
      dp({ variableName: "email", label: "Email" }), // new
    ];
    const result = regenerateDataChain(path, dps, "close", "p");

    applyRegeneratedChain(flow, result);
    const ids = ((flow.conversationFlow as any).nodes as any[]).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
