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

    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");

    const collectFirst = newNodes.find((n) => n.name === "Collect First Name");
    const collectLast = newNodes.find((n) => n.name === "Collect Last Name");
    expect(collectFirst?.id).toBe("collect-1");
    expect(collectLast?.id).toBe("collect-2");
  });

  it("preserves the front-extract and router IDs", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "first_name", label: "First Name" })];

    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");

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

    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
    const front = newNodes.find((n) => n.id === "extract")!;
    expect(namesOf(front)).toEqual(["first_name", "last_name", "email", "_path_taken"]);
  });

  it("appends _path_taken to front-extract only when pathName is given", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "first_name", label: "First Name" })];

    const withName = regenerateDataChain(path, dps, "close", "close-q", "p");
    const withoutName = regenerateDataChain(path, dps, "close", "close-q");

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

    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
    const router = newNodes.find((n) => n.id === "router") as any;

    // 2 non-orphan DP edges + 1 _close_was_said shortcut = 3 total.
    expect(router.edges).toHaveLength(3);
    expect(router.else_edge.destination_node_id).toBe("close");
  });

  it("router else_edge points to the close node in callback mode", () => {
    const flow = buildFlow([{ id: "1", name: "first_name" }]);
    const path = pathFor(flow);
    expect(path.endMode).toBe("callback");

    const { newNodes } = regenerateDataChain(path, [dp({ variableName: "first_name", label: "First Name" })], "close", "close-q", "p");
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

    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
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
    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
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

    const { removedNodeIds } = regenerateDataChain(path, dps, "close", "close-q", "p");
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

    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
    const confirm = newNodes.find((n) => n.name === "Confirm Phone Number") as any;
    expect(namesOf(confirm)).toContain("phone_number_collected");
  });

  it("phone_number router edge uses && operator and checks the collected flag", () => {
    const flow = buildFlow([{ id: "1", name: "phone_number" }]);
    const path = pathFor(flow);
    const dps = [dp({ variableName: "phone_number", label: "Phone Number" })];

    const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
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
    const result = regenerateDataChain(path, dps, "close", "close-q", "p");

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
    const result = regenerateDataChain(path, dps, "close", "close-q", "p");

    applyRegeneratedChain(flow, result);
    const ids = ((flow.conversationFlow as any).nodes as any[]).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ── Fine-tune propagation (regression guards) ─────────────────────────────
  // These cover the bug where workspace-default fine-tunes added in the
  // dashboard's global-settings UI never reached published agents because:
  //   1. buildDataPointsFromChain hardcoded finetuneExamples: []
  //   2. regenerateDataChain only read existingCollectNode.finetune_transition_examples
  // After the fix, dp.finetuneExamples wins; existing-node FTs are only the
  // fallback for DPs with no resolved value.
  describe("fine-tune propagation", () => {
    function fteOf(node: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
      return (node?.finetune_transition_examples as Array<Record<string, unknown>>) ?? [];
    }

    it("writes dp.finetuneExamples onto the regenerated Collect node", () => {
      const flow = buildFlow([{ id: "1", name: "first_name" }]);
      const path = pathFor(flow);
      const dps = [
        dp({
          variableName: "first_name",
          label: "First Name",
          finetuneExamples: [
            { type: "negative", transcript: [{ role: "user", content: "It's John." }, { role: "agent", content: "And your last name?" }] },
          ],
        }),
      ];

      const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
      const collectNode = newNodes.find((n) => n.name === "Collect First Name");
      expect(fteOf(collectNode)).toHaveLength(1);
      expect((fteOf(collectNode)[0].transcript as any)[0].content).toBe("It's John.");
    });

    it("overwrites stale FTs already on the existing Collect node", () => {
      // Existing flow has an old FT baked in; the new dp carries a different one.
      const flow = buildFlow([{ id: "1", name: "first_name" }]);
      const nodes = (flow.conversationFlow as any).nodes as any[];
      const oldCollect = nodes.find((n) => n.id === "collect-1");
      oldCollect.finetune_transition_examples = [
        { transcript: [{ role: "user", content: "STALE EXAMPLE" }] },
      ];
      const path = pathFor(flow);

      const dps = [
        dp({
          variableName: "first_name",
          label: "First Name",
          finetuneExamples: [
            { type: "negative", transcript: [{ role: "user", content: "NEW EXAMPLE" }, { role: "agent", content: "ack" }] },
          ],
        }),
      ];

      const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
      const collectNode = newNodes.find((n) => n.name === "Collect First Name");
      const ftes = fteOf(collectNode);
      expect(ftes).toHaveLength(1);
      expect((ftes[0].transcript as any)[0].content).toBe("NEW EXAMPLE");
      // Stale example must not bleed through.
      expect(ftes.some((ex) => (ex.transcript as any)?.[0]?.content === "STALE EXAMPLE")).toBe(false);
    });

    it("falls back to existing-node FTs when dp.finetuneExamples is empty", () => {
      const flow = buildFlow([{ id: "1", name: "first_name" }]);
      const nodes = (flow.conversationFlow as any).nodes as any[];
      const oldCollect = nodes.find((n) => n.id === "collect-1");
      oldCollect.finetune_transition_examples = [
        { transcript: [{ role: "user", content: "PRESERVED" }] },
      ];
      const path = pathFor(flow);

      // No finetuneExamples on the dp — preserves whatever's on the node.
      const dps = [dp({ variableName: "first_name", label: "First Name" })];
      const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
      const collectNode = newNodes.find((n) => n.name === "Collect First Name");
      const ftes = fteOf(collectNode);
      expect(ftes).toHaveLength(1);
      expect((ftes[0].transcript as any)[0].content).toBe("PRESERVED");
    });

    it("assigns destination_node_id to positive examples (Confirm node)", () => {
      // Positive examples train the model to advance from Collect → Confirm
      // for matching utterances. resolveFinetuneExamples must rewrite the
      // destination to the new chain's confirm id.
      const flow = buildFlow([{ id: "1", name: "first_name" }]);
      const path = pathFor(flow);
      const dps = [
        dp({
          variableName: "first_name",
          label: "First Name",
          finetuneExamples: [
            { type: "positive", transcript: [{ role: "user", content: "John Smith" }, { role: "agent", content: "Thanks." }] },
          ],
        }),
      ];

      const { newNodes } = regenerateDataChain(path, dps, "close", "close-q", "p");
      const collectNode = newNodes.find((n) => n.name === "Collect First Name");
      const confirmNode = newNodes.find((n) => n.name === "Confirm First Name");
      const ftes = fteOf(collectNode);
      expect(ftes).toHaveLength(1);
      expect(ftes[0].destination_node_id).toBe(confirmNode!.id);
    });

    it("emits unique finetune ids when one data-point-default example regenerates onto multiple paths", () => {
      // Repro of the Retell "400 Duplicate example id" rejection: a
      // workspace data-point-default carries one finetune example with a
      // fixed id; the data point is used on multiple paths, so its Collect
      // node is regenerated once per path. Each path's copy must get a
      // distinct id and must never reuse the source example's id.
      const sharedDp = dp({
        variableName: "first_name",
        label: "First Name",
        finetuneExamples: [
          { type: "negative", id: "fe-shared-1779206577800", transcript: [{ role: "user", content: "skip" }] },
        ],
      });
      const a = regenerateDataChain(
        pathFor(buildFlow([{ id: "1", name: "first_name" }])),
        [sharedDp],
        "close",
        "close-q",
        "pathA",
      );
      const b = regenerateDataChain(
        pathFor(buildFlow([{ id: "1", name: "first_name" }])),
        [sharedDp],
        "close",
        "close-q",
        "pathB",
      );
      const ids = [...a.newNodes, ...b.newNodes]
        .filter((n) => String(n.name).startsWith("Collect "))
        .flatMap((n) => fteOf(n).map((e) => e.id as string));
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2); // no duplicate ids across the paths
      expect(ids).not.toContain("fe-shared-1779206577800"); // source id never reused
    });
  });
});
