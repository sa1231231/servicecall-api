import { describe, it, expect } from "vitest";
import { validateConversationFlow } from "../node-validator.js";

function flow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start_node_id: "start",
    global_prompt: "You are a helpful assistant.",
    nodes: [
      {
        id: "start",
        name: "Start",
        type: "conversation",
        instruction: { type: "prompt", text: "Hi there." },
        edges: [
          {
            destination_node_id: "end",
            transition_condition: { type: "prompt", prompt: "Ready to end" },
          },
        ],
      },
      { id: "end", name: "End", type: "end" },
    ],
    ...overrides,
  };
}

function codes(errors: ReturnType<typeof validateConversationFlow>): string[] {
  return errors.map((e) => e.code);
}

describe("validateConversationFlow", () => {
  it("accepts a minimal valid flow", () => {
    expect(validateConversationFlow(flow())).toEqual([]);
  });

  describe("structural errors", () => {
    it("rejects empty nodes", () => {
      expect(codes(validateConversationFlow({ nodes: [], start_node_id: "x", global_prompt: "g" }))).toEqual(["NO_NODES"]);
    });

    it("rejects missing nodes array entirely", () => {
      expect(codes(validateConversationFlow({ start_node_id: "x", global_prompt: "g" }))).toEqual(["NO_NODES"]);
    });

    it("returns early on NO_NODES (no other errors leak through)", () => {
      // If NO_NODES short-circuits, we shouldn't also see NO_START_NODE / NO_GLOBAL_PROMPT.
      const errors = validateConversationFlow({});
      expect(errors).toHaveLength(1);
      expect(errors[0].code).toBe("NO_NODES");
    });

    it("rejects missing start_node_id", () => {
      const errors = validateConversationFlow(flow({ start_node_id: undefined }));
      expect(codes(errors)).toContain("NO_START_NODE");
    });

    it("rejects empty/whitespace global_prompt", () => {
      expect(codes(validateConversationFlow(flow({ global_prompt: "" })))).toContain("NO_GLOBAL_PROMPT");
      expect(codes(validateConversationFlow(flow({ global_prompt: "   " })))).toContain("NO_GLOBAL_PROMPT");
    });

    it("rejects non-string global_prompt", () => {
      expect(codes(validateConversationFlow(flow({ global_prompt: 42 })))).toContain("NO_GLOBAL_PROMPT");
    });

    it("flags start_node_id that doesn't reference an existing node", () => {
      const errors = validateConversationFlow(flow({ start_node_id: "ghost" }));
      expect(codes(errors)).toContain("START_NODE_MISSING");
    });
  });

  describe("node-level errors", () => {
    it("flags duplicate node ids", () => {
      const errors = validateConversationFlow(
        flow({
          nodes: [
            { id: "dup", name: "A", type: "end" },
            { id: "dup", name: "B", type: "end" },
          ],
          start_node_id: "dup",
          global_prompt: "g",
        }),
      );
      expect(codes(errors)).toContain("DUPLICATE_NODE_ID");
    });

    it("flags node missing id, name, type", () => {
      const errors = validateConversationFlow({
        start_node_id: "real",
        global_prompt: "g",
        nodes: [
          { id: "real", name: "Real", type: "end" },
          {},
        ],
      });
      const c = codes(errors);
      expect(c).toContain("NODE_NO_ID");
      // The id-less node is skipped for name/type checks (continue in loop), so we
      // only assert NODE_NO_ID here.
    });

    it("flags missing name and type when id is present", () => {
      const errors = validateConversationFlow({
        start_node_id: "real",
        global_prompt: "g",
        nodes: [
          { id: "real", name: "Real", type: "end" },
          { id: "incomplete" },
        ],
      });
      const c = codes(errors);
      expect(c).toContain("NODE_NO_NAME");
      expect(c).toContain("NODE_NO_TYPE");
    });
  });

  describe("edge validation", () => {
    it("flags edge with missing destination", () => {
      const f = flow();
      (f.nodes as any[])[0].edges = [{ transition_condition: { type: "prompt", prompt: "x" } }];
      expect(codes(validateConversationFlow(f))).toContain("EDGE_NO_DEST");
    });

    it("flags edge with destination pointing at non-existent node", () => {
      const f = flow();
      (f.nodes as any[])[0].edges = [
        { destination_node_id: "ghost", transition_condition: { type: "prompt", prompt: "x" } },
      ];
      expect(codes(validateConversationFlow(f))).toContain("EDGE_INVALID_DEST");
    });

    it("flags edge with no transition_condition", () => {
      const f = flow();
      (f.nodes as any[])[0].edges = [{ destination_node_id: "end" }];
      expect(codes(validateConversationFlow(f))).toContain("EDGE_NO_CONDITION");
    });

    it("flags skip_response_edge / always_edge / else_edge with invalid destinations", () => {
      const f = flow();
      const start = (f.nodes as any[])[0];
      start.skip_response_edge = { destination_node_id: "ghost1" };
      start.always_edge = { destination_node_id: "ghost2" };
      start.else_edge = { destination_node_id: "ghost3" };
      const c = codes(validateConversationFlow(f));
      expect(c).toContain("SKIP_EDGE_INVALID_DEST");
      expect(c).toContain("ALWAYS_EDGE_INVALID_DEST");
      expect(c).toContain("ELSE_EDGE_INVALID_DEST");
    });
  });

  describe("orphan detection", () => {
    it("flags a node not reachable from start", () => {
      const errors = validateConversationFlow({
        start_node_id: "start",
        global_prompt: "g",
        nodes: [
          {
            id: "start",
            name: "Start",
            type: "conversation",
            instruction: { type: "prompt", text: "Hi" },
            edges: [{ destination_node_id: "end", transition_condition: { type: "prompt", prompt: "x" } }],
          },
          { id: "end", name: "End", type: "end" },
          { id: "lonely", name: "Lonely", type: "end" },
        ],
      });
      const orphans = errors.filter((e) => e.code === "ORPHANED_NODE");
      expect(orphans).toHaveLength(1);
      expect(orphans[0].nodeId).toBe("lonely");
    });

    it("does NOT flag a node only reachable via a global node", () => {
      const errors = validateConversationFlow({
        start_node_id: "start",
        global_prompt: "g",
        nodes: [
          { id: "start", name: "Start", type: "conversation", instruction: { type: "prompt", text: "Hi" } },
          {
            id: "global-faq",
            name: "FAQ",
            type: "conversation",
            instruction: { type: "prompt", text: "Answer FAQs" },
            global_node_setting: { condition: "user asks a question" },
            edges: [{ destination_node_id: "faq-end", transition_condition: { type: "prompt", prompt: "x" } }],
          },
          { id: "faq-end", name: "FAQ End", type: "end" },
        ],
      });
      expect(codes(errors)).not.toContain("ORPHANED_NODE");
    });
  });

  describe("conversation node validation", () => {
    it("flags missing instruction", () => {
      const f = flow();
      delete (f.nodes as any[])[0].instruction;
      expect(codes(validateConversationFlow(f))).toContain("CONV_NO_INSTRUCTION");
    });

    it("flags empty instruction text", () => {
      const f = flow();
      (f.nodes as any[])[0].instruction = { type: "prompt", text: "   " };
      expect(codes(validateConversationFlow(f))).toContain("CONV_EMPTY_INSTRUCTION");
    });

    it("flags missing instruction type", () => {
      const f = flow();
      (f.nodes as any[])[0].instruction = { text: "Hello" };
      expect(codes(validateConversationFlow(f))).toContain("CONV_NO_INSTRUCTION_TYPE");
    });
  });

  describe("extract node validation", () => {
    function extractFlow(extractOverrides: Record<string, unknown>) {
      return {
        start_node_id: "ex",
        global_prompt: "g",
        nodes: [
          {
            id: "ex",
            name: "Extract All Variables",
            type: "extract_dynamic_variables",
            else_edge: {
              destination_node_id: "end",
              transition_condition: { type: "prompt", prompt: "x" },
            },
            ...extractOverrides,
          },
          { id: "end", name: "End", type: "end" },
        ],
      };
    }

    it("flags extract node with no variables", () => {
      expect(codes(validateConversationFlow(extractFlow({ variables: [] })))).toContain("EXTRACT_NO_VARS");
      expect(codes(validateConversationFlow(extractFlow({})))).toContain("EXTRACT_NO_VARS");
    });

    it("flags duplicate variable names within a single extract node", () => {
      const errors = validateConversationFlow(
        extractFlow({
          variables: [
            { name: "name", type: "string", description: "d" },
            { name: "name", type: "string", description: "d" },
          ],
        }),
      );
      expect(codes(errors)).toContain("EXTRACT_VAR_DUPLICATE");
    });

    it("flags variable with no name", () => {
      const errors = validateConversationFlow(
        extractFlow({
          variables: [{ type: "string", description: "d" }],
        }),
      );
      expect(codes(errors)).toContain("EXTRACT_VAR_NO_NAME");
    });

    it("flags missing else_edge", () => {
      const errors = validateConversationFlow({
        start_node_id: "ex",
        global_prompt: "g",
        nodes: [
          {
            id: "ex",
            name: "Extract All Variables",
            type: "extract_dynamic_variables",
            variables: [{ name: "v", type: "string", description: "d" }],
          },
        ],
      });
      expect(codes(errors)).toContain("EXTRACT_NO_ELSE_EDGE");
    });
  });

  describe("branch node validation", () => {
    it("flags branch with no edges", () => {
      const errors = validateConversationFlow({
        start_node_id: "br",
        global_prompt: "g",
        nodes: [
          {
            id: "br",
            name: "Router",
            type: "branch",
            else_edge: { destination_node_id: "end", transition_condition: { type: "prompt", prompt: "x" } },
          },
          { id: "end", name: "End", type: "end" },
        ],
      });
      expect(codes(errors)).toContain("BRANCH_NO_EDGES");
    });

    it("flags branch with empty equation array on an equation edge", () => {
      const errors = validateConversationFlow({
        start_node_id: "br",
        global_prompt: "g",
        nodes: [
          {
            id: "br",
            name: "Router",
            type: "branch",
            else_edge: { destination_node_id: "end", transition_condition: { type: "prompt", prompt: "x" } },
            edges: [
              {
                destination_node_id: "end",
                transition_condition: { type: "equation", equations: [], operator: "&&" },
              },
            ],
          },
          { id: "end", name: "End", type: "end" },
        ],
      });
      expect(codes(errors)).toContain("BRANCH_EMPTY_EQUATIONS");
    });

    it("flags branch with no else_edge", () => {
      const errors = validateConversationFlow({
        start_node_id: "br",
        global_prompt: "g",
        nodes: [
          {
            id: "br",
            name: "Router",
            type: "branch",
            edges: [
              {
                destination_node_id: "end",
                transition_condition: { type: "equation", equations: [{ left: "a", operator: "==", right: "b" }] },
              },
            ],
          },
          { id: "end", name: "End", type: "end" },
        ],
      });
      expect(codes(errors)).toContain("BRANCH_NO_ELSE_EDGE");
    });
  });

  describe("transfer node validation", () => {
    it("flags transfer node missing destination number", () => {
      const errors = validateConversationFlow({
        start_node_id: "t",
        global_prompt: "g",
        nodes: [
          { id: "t", name: "Transfer", type: "transfer_call" },
        ],
      });
      expect(codes(errors)).toContain("TRANSFER_NO_DEST");
    });

    it("accepts a transfer node with a valid number", () => {
      const errors = validateConversationFlow({
        start_node_id: "t",
        global_prompt: "g",
        nodes: [
          {
            id: "t",
            name: "Transfer",
            type: "transfer_call",
            transfer_destination: { number: "+15555550100" },
          },
        ],
      });
      expect(codes(errors)).not.toContain("TRANSFER_NO_DEST");
    });
  });
});
