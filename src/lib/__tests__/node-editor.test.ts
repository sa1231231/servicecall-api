import { describe, it, expect } from "vitest";
import {
  generateAgent,
  resolveDataPoints,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  defaultExtractEquation,
  type DataPoint,
} from "../agent-generator/index.js";
import { parseConversationFlow, getPathVariableNames, getPathNodeIds, isStructuralNode } from "../node-parser.js";
import { validateConversationFlow, type ValidationError } from "../node-validator.js";
import { regenerateDataChain, applyRegeneratedChain } from "../node-regenerator.js";

// ── Test Data ────────────────────────────────────────────────────────────────

const baseConfig = {
  businessName: "Test Co",
  faqKnowledgeBase: "FAQ content here",
  introFinetuneExamples: [],
};

const TEST_DEFAULTS: Record<string, DataPoint> = {
  full_name: {
    label: "Full Name",
    variableName: "full_name",
    type: "string",
    description: `Full name. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for the caller's name.",
    forwardCondition: "The caller has given their name",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("full_name"),
  },
  phone_number: {
    label: "Phone Number",
    variableName: "phone_number",
    type: "string",
    description: `Phone number. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for their phone number.",
    forwardCondition: "The caller has provided their phone number",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("phone_number"),
  },
  city: {
    label: "City",
    variableName: "city",
    type: "string",
    description: `City. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for the city.",
    forwardCondition: "The caller has given their city",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("city"),
  },
  email: {
    label: "Email",
    variableName: "email",
    type: "string",
    description: `Email address. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for their email address.",
    forwardCondition: "The caller has provided their email",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("email"),
  },
  vehicle_type: {
    label: "Vehicle Type",
    variableName: "vehicle_type",
    type: "enum",
    choices: ["Semi", "Box truck", CALLER_DOESNT_KNOW, "Other", NOT_MENTIONED],
    description: `Vehicle type. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask what type of truck.",
    forwardCondition: "The caller has provided the vehicle type",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("vehicle_type"),
  },
  scheduling: {
    composite: true,
    label: "Day / Time Preference",
    variableName: "scheduling",
    type: "string",
    description: "",
    variables: [
      { variableName: "preferred_day", type: "enum", choices: ["Monday", "Tuesday", CALLER_DOESNT_KNOW, NOT_MENTIONED], description: "Day preference" },
      { variableName: "preferred_time", type: "enum", choices: ["8 AM - 10 AM", "10 AM - 12 PM", CALLER_DOESNT_KNOW, NOT_MENTIONED], description: "Time preference" },
    ],
    conversationPrompt: "Ask when they want someone to come out.",
    forwardCondition: "The caller has agreed to a day and time or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: [],
  },
};

function generateSinglePath(dpKeys: string[]) {
  return generateAgent(baseConfig, dpKeys, undefined, TEST_DEFAULTS);
}

function generateMultiPath() {
  return generateAgent(baseConfig, [], [
    { name: "Residential", transitionCondition: "Caller needs residential service", dataPoints: ["full_name", "phone_number"] },
    { name: "Commercial", transitionCondition: "Caller needs commercial service", dataPoints: ["full_name", "city"] },
  ], TEST_DEFAULTS);
}

/** Helper: extract DataPoint[] from a parsed path for regeneration */
function dataPointsFromChain(chain: ReturnType<typeof parseConversationFlow>["paths"][0]["dataChain"]): DataPoint[] {
  return chain.map((dp) => ({
    label: dp.label,
    variableName: dp.variableName,
    type: (dp.variableDefs[0]?.type as DataPoint["type"]) ?? "string",
    choices: dp.variableDefs[0]?.choices ?? [],
    description: dp.variableDefs[0]?.description ?? "",
    conversationPrompt: dp.conversationPrompt,
    forwardCondition: dp.forwardCondition,
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation(dp.variableName),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// NODE PARSER
// ═══════════════════════════════════════════════════════════════════════════════

describe("parseConversationFlow", () => {
  it("parses a single-path agent", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);

    expect(parsed.introNode).toBeDefined();
    expect(parsed.introNode.name).toBe("Intro");
    expect(parsed.faqNode?.name).toBe("Admin/FAQ");
    expect(parsed.closeNode?.name).toBe("Close");
    expect(parsed.paths).toHaveLength(1);

    const path = parsed.paths[0];
    expect(path.name).toBe("Default");
    expect(path.dataChain).toHaveLength(3);
    expect(path.dataChain[0].variableName).toBe("full_name");
    expect(path.dataChain[1].variableName).toBe("phone_number");
    expect(path.dataChain[2].variableName).toBe("city");
  });

  it("extracts data point details correctly", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);
    const dp = parsed.paths[0].dataChain[0];

    expect(dp.variableName).toBe("full_name");
    expect(dp.label).toBe("Full Name");
    expect(dp.conversationPrompt).toContain("Ask for the caller's name");
    expect(dp.forwardCondition).toContain("name");
    expect(dp.collectNode.type).toBe("conversation");
    expect(dp.confirmNode.type).toBe("extract_dynamic_variables");
    expect(dp.variableDefs.length).toBeGreaterThan(0);
    expect(dp.variableDefs[0].name).toBe("full_name");
  });

  it("parses a multi-path agent", () => {
    const { agent } = generateMultiPath();
    const parsed = parseConversationFlow(agent);

    expect(parsed.paths).toHaveLength(2);
    expect(parsed.paths[0].name).toBe("Residential");
    expect(parsed.paths[0].dataChain[0].variableName).toBe("full_name");
    expect(parsed.paths[0].dataChain[1].variableName).toBe("phone_number");
    expect(parsed.paths[1].name).toBe("Commercial");
    expect(parsed.paths[1].dataChain[0].variableName).toBe("full_name");
    expect(parsed.paths[1].dataChain[1].variableName).toBe("city");
  });

  it("identifies global nodes", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);
    const globalNames = parsed.globalNodes.map((n) => n.name);

    expect(globalNames).toContain("Admin/FAQ");
    expect(globalNames).toContain("Human Request");
    expect(globalNames).toContain("irrelevantGaurdrail");
    expect(globalNames).toContain("Emergency Gaurd Rail");
  });

  it("extracts globalPrompt and startNodeId", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);

    expect(parsed.globalPrompt).toContain("Test Co");
    expect(parsed.globalPrompt).toContain("Anthony");
    expect(parsed.startNodeId).toBe(parsed.introNode.id);
  });

  it("parses single data point agent", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);

    expect(parsed.paths[0].dataChain).toHaveLength(1);
    expect(parsed.paths[0].routerNode).toBeDefined();
    expect(parsed.paths[0].frontExtractNode).toBeDefined();
  });

  it("parses composite data points", () => {
    const { agent } = generateSinglePath(["scheduling"]);
    const parsed = parseConversationFlow(agent);

    const dp = parsed.paths[0].dataChain[0];
    expect(dp.variableDefs.length).toBeGreaterThanOrEqual(2);
    const varNames = dp.variableDefs.map(v => v.name);
    expect(varNames).toContain("preferred_day");
    expect(varNames).toContain("preferred_time");
  });

  it("parses enum data points with choices", () => {
    const { agent } = generateSinglePath(["vehicle_type"]);
    const parsed = parseConversationFlow(agent);

    const dp = parsed.paths[0].dataChain[0];
    expect(dp.variableDefs[0].type).toBe("enum");
  });

  it("identifies closing nodes", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);

    expect(parsed.closingNodes.length).toBeGreaterThan(0);
    const closingNames = parsed.closingNodes.map(n => n.name);
    expect(closingNames).toContain("Closing Remarks");
    expect(closingNames).toContain("Closing Statement");
  });

  it("getPathVariableNames returns ordered variable names", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);
    expect(getPathVariableNames(parsed.paths[0])).toEqual(["full_name", "phone_number", "city"]);
  });

  it("getPathNodeIds returns all node IDs in a path", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const parsed = parseConversationFlow(agent);
    const ids = getPathNodeIds(parsed.paths[0]);
    // transition + frontExtract + router + 2*(collect + confirm) = 7
    expect(ids.size).toBe(7);
  });

  it("isStructuralNode identifies non-chain nodes", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);

    expect(isStructuralNode(parsed.introNode, parsed)).toBe(true);
    expect(isStructuralNode(parsed.faqNode!, parsed)).toBe(true);
    expect(isStructuralNode(parsed.paths[0].dataChain[0].collectNode, parsed)).toBe(false);
  });

  it("throws on missing conversationFlow", () => {
    expect(() => parseConversationFlow({})).toThrow("Missing conversationFlow");
  });

  it("throws on empty nodes", () => {
    expect(() => parseConversationFlow({ conversationFlow: { nodes: [] } })).toThrow("No nodes");
  });

  it("parses agents with live_transfer mode", () => {
    const { agent } = generateAgent(
      { ...baseConfig, humanRequestMode: "live_transfer" },
      ["full_name"], undefined, TEST_DEFAULTS,
    );
    const parsed = parseConversationFlow(agent);

    const nodeNames = parsed.allNodes.map(n => n.name);
    expect(nodeNames).toContain("Transfer Call");
    expect(nodeNames).toContain("Transfer Failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NODE VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("validateConversationFlow", () => {
  describe("valid flows pass", () => {
    it("single-path with 1 data point", () => {
      const { agent } = generateSinglePath(["full_name"]);
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });

    it("single-path with multiple data points", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });

    it("multi-path agent", () => {
      const { agent } = generateMultiPath();
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });

    it("agent with composite data points", () => {
      const { agent } = generateSinglePath(["full_name", "scheduling"]);
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });

    it("agent with enum data points", () => {
      const { agent } = generateSinglePath(["vehicle_type"]);
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });

    it("agent with live_transfer mode", () => {
      const { agent } = generateAgent(
        { ...baseConfig, humanRequestMode: "live_transfer" },
        ["full_name"], undefined, TEST_DEFAULTS,
      );
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });

    it("agent with branch conditions", () => {
      const { agent } = generateAgent(baseConfig, [
        "vehicle_type",
        { _branch: true as const, variable: "vehicle_type", operator: "==" as const, value: "Semi",
          ifChain: ["phone_number"], elseChain: ["city"] },
      ] as any[], undefined, TEST_DEFAULTS);
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });
  });

  describe("catches structural errors", () => {
    it("missing nodes array", () => {
      const errors = validateConversationFlow({ global_prompt: "test", start_node_id: "x" });
      expect(errors.some(e => e.code === "NO_NODES")).toBe(true);
    });

    it("empty nodes array", () => {
      const errors = validateConversationFlow({ global_prompt: "test", start_node_id: "x", nodes: [] });
      expect(errors.some(e => e.code === "NO_NODES")).toBe(true);
    });

    it("missing start_node_id", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = { ...(agent.conversationFlow as any) };
      delete flow.start_node_id;
      expect(validateConversationFlow(flow).some(e => e.code === "NO_START_NODE")).toBe(true);
    });

    it("start_node_id references nonexistent node", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = { ...(agent.conversationFlow as any) };
      flow.start_node_id = "nonexistent-id";
      expect(validateConversationFlow(flow).some(e => e.code === "START_NODE_MISSING")).toBe(true);
    });

    it("empty global_prompt", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = { ...(agent.conversationFlow as any) };
      flow.global_prompt = "";
      expect(validateConversationFlow(flow).some(e => e.code === "NO_GLOBAL_PROMPT")).toBe(true);
    });

    it("missing global_prompt", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = { ...(agent.conversationFlow as any) };
      delete flow.global_prompt;
      expect(validateConversationFlow(flow).some(e => e.code === "NO_GLOBAL_PROMPT")).toBe(true);
    });

    it("duplicate node IDs", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const firstNode = { ...flow.nodes[0] };
      flow.nodes.push(firstNode);
      expect(validateConversationFlow(flow).some(e => e.code === "DUPLICATE_NODE_ID")).toBe(true);
    });

    it("node without id", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      flow.nodes.push({ name: "Bad Node", type: "conversation" });
      expect(validateConversationFlow(flow).some(e => e.code === "NODE_NO_ID")).toBe(true);
    });

    it("node without name", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      flow.nodes.push({ id: "bad-node", type: "conversation", instruction: { type: "prompt", text: "x" } });
      expect(validateConversationFlow(flow).some(e => e.code === "NODE_NO_NAME")).toBe(true);
    });
  });

  describe("catches edge errors", () => {
    it("edge pointing to nonexistent node", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const intro = flow.nodes.find((n: any) => n.name === "Intro");
      intro.edges[0].destination_node_id = "nonexistent-id";
      expect(validateConversationFlow(flow).some(e => e.code === "EDGE_INVALID_DEST")).toBe(true);
    });

    it("skip_response_edge pointing to nonexistent node", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const transition = flow.nodes.find((n: any) => n.name === "Conversation");
      if (transition?.skip_response_edge) {
        transition.skip_response_edge.destination_node_id = "bad-id";
        expect(validateConversationFlow(flow).some(e => e.code === "SKIP_EDGE_INVALID_DEST")).toBe(true);
      }
    });

    it("else_edge pointing to nonexistent node", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const router = flow.nodes.find((n: any) => n.name === "Variables Router");
      router.else_edge.destination_node_id = "bad-id";
      expect(validateConversationFlow(flow).some(e => e.code === "ELSE_EDGE_INVALID_DEST")).toBe(true);
    });

    it("edge without transition_condition", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const intro = flow.nodes.find((n: any) => n.name === "Intro");
      delete intro.edges[0].transition_condition;
      expect(validateConversationFlow(flow).some(e => e.code === "EDGE_NO_CONDITION")).toBe(true);
    });
  });

  describe("catches type-specific errors", () => {
    it("conversation node without instruction", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const intro = flow.nodes.find((n: any) => n.name === "Intro");
      delete intro.instruction;
      expect(validateConversationFlow(flow).some(e => e.code === "CONV_NO_INSTRUCTION")).toBe(true);
    });

    it("conversation node with empty instruction text", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const intro = flow.nodes.find((n: any) => n.name === "Intro");
      intro.instruction.text = "";
      expect(validateConversationFlow(flow).some(e => e.code === "CONV_EMPTY_INSTRUCTION")).toBe(true);
    });

    it("extract node without variables", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const extractNode = flow.nodes.find((n: any) => n.type === "extract_dynamic_variables");
      extractNode.variables = [];
      expect(validateConversationFlow(flow).some(e => e.code === "EXTRACT_NO_VARS")).toBe(true);
    });

    it("extract node with duplicate variable names", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const extractNode = flow.nodes.find((n: any) =>
        n.type === "extract_dynamic_variables" && n.name.startsWith("Confirm"));
      if (extractNode?.variables?.length > 0) {
        extractNode.variables.push({ ...extractNode.variables[0] });
        expect(validateConversationFlow(flow).some(e => e.code === "EXTRACT_VAR_DUPLICATE")).toBe(true);
      }
    });

    it("extract node without else_edge", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const extractNode = flow.nodes.find((n: any) =>
        n.type === "extract_dynamic_variables" && n.name.startsWith("Confirm"));
      delete extractNode.else_edge;
      expect(validateConversationFlow(flow).some(e => e.code === "EXTRACT_NO_ELSE_EDGE")).toBe(true);
    });

    it("branch node without edges", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const router = flow.nodes.find((n: any) => n.type === "branch");
      router.edges = [];
      expect(validateConversationFlow(flow).some(e => e.code === "BRANCH_NO_EDGES")).toBe(true);
    });

    it("branch node without else_edge", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const flow = agent.conversationFlow as any;
      const router = flow.nodes.find((n: any) => n.type === "branch");
      delete router.else_edge;
      expect(validateConversationFlow(flow).some(e => e.code === "BRANCH_NO_ELSE_EDGE")).toBe(true);
    });

    it("transfer node without destination", () => {
      const { agent } = generateAgent(
        { ...baseConfig, humanRequestMode: "live_transfer" },
        ["full_name"], undefined, TEST_DEFAULTS,
      );
      const flow = agent.conversationFlow as any;
      const transfer = flow.nodes.find((n: any) => n.type === "transfer_call");
      delete transfer.transfer_destination;
      expect(validateConversationFlow(flow).some(e => e.code === "TRANSFER_NO_DEST")).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NODE REGENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("regenerateDataChain", () => {
  describe("identity operations", () => {
    it("regenerates with same data points (preserves node IDs)", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const origIds = {
        collect0: path.dataChain[0].collectNode.id,
        confirm0: path.dataChain[0].confirmNode.id,
        collect1: path.dataChain[1].collectNode.id,
        confirm1: path.dataChain[1].confirmNode.id,
        frontExtract: path.frontExtractNode.id,
        router: path.routerNode.id,
      };

      const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id);
      const newIds = result.newNodes.map(n => n.id);

      expect(newIds).toContain(origIds.collect0);
      expect(newIds).toContain(origIds.confirm0);
      expect(newIds).toContain(origIds.collect1);
      expect(newIds).toContain(origIds.confirm1);
      expect(newIds).toContain(origIds.frontExtract);
      expect(newIds).toContain(origIds.router);
    });

    it("identity regeneration produces valid flow", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);
      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });
  });

  describe("add data points", () => {
    it("adds a data point at the end", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city];

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(reParsed.paths[0].dataChain).toHaveLength(3);
      expect(reParsed.paths[0].dataChain[2].variableName).toBe("city");
    });

    it("adds a data point at the beginning", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = [TEST_DEFAULTS.city, ...dataPointsFromChain(path.dataChain)];

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(reParsed.paths[0].dataChain[0].variableName).toBe("city");
    });

    it("adds a data point in the middle", () => {
      const { agent } = generateSinglePath(["full_name", "city"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const existing = dataPointsFromChain(path.dataChain);
      const dps = [existing[0], TEST_DEFAULTS.phone_number, existing[1]];

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      const vars = reParsed.paths[0].dataChain.map(dp => dp.variableName);
      expect(vars).toEqual(["full_name", "phone_number", "city"]);
    });

    it("adds multiple data points at once", () => {
      const { agent } = generateSinglePath(["full_name"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.phone_number, TEST_DEFAULTS.city, TEST_DEFAULTS.email];

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(reParsed.paths[0].dataChain).toHaveLength(4);
    });
  });

  describe("remove data points", () => {
    it("removes a data point from the middle", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = dataPointsFromChain(path.dataChain).filter(dp => dp.variableName !== "phone_number");

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(getPathVariableNames(reParsed.paths[0])).toEqual(["full_name", "city"]);
    });

    it("removes the first data point", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = dataPointsFromChain(path.dataChain).filter(dp => dp.variableName !== "full_name");

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(getPathVariableNames(reParsed.paths[0])).toEqual(["phone_number", "city"]);
    });

    it("removes the last data point", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = dataPointsFromChain(path.dataChain).filter(dp => dp.variableName !== "city");

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(getPathVariableNames(reParsed.paths[0])).toEqual(["full_name", "phone_number"]);
    });

    it("reduces to single data point", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = dataPointsFromChain(path.dataChain).filter(dp => dp.variableName === "full_name");

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(reParsed.paths[0].dataChain).toHaveLength(1);
    });
  });

  describe("reorder data points", () => {
    it("reverses data point order", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const dps = dataPointsFromChain(path.dataChain).reverse();

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(getPathVariableNames(reParsed.paths[0])).toEqual(["city", "phone_number", "full_name"]);
    });

    it("swaps two data points", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];
      const existing = dataPointsFromChain(path.dataChain);
      const dps = [existing[2], existing[1], existing[0]]; // city, phone, name

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    });
  });

  describe("preserves non-chain state", () => {
    it("preserves intro, FAQ, close, and guardrail nodes", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number"]);
      const parsed = parseConversationFlow(agent);
      const totalBefore = parsed.allNodes.length;

      const path = parsed.paths[0];
      const dps = [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city];
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      const reParsed = parseConversationFlow(agent);
      expect(reParsed.introNode.name).toBe("Intro");
      expect(reParsed.faqNode?.name).toBe("Admin/FAQ");
      expect(reParsed.closeNode?.name).toBe("Close");
      expect(reParsed.globalNodes.length).toBeGreaterThan(0);
      expect(reParsed.allNodes.length).toBe(totalBefore + 2);
    });

    it("preserves existing node prompt text on unchanged data points", () => {
      const { agent } = generateSinglePath(["full_name", "phone_number"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];

      // Get original prompt for full_name
      const origPrompt = path.dataChain[0].conversationPrompt;

      // Add city, but full_name should keep its original prompt
      const dps = [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city];
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      const reParsed = parseConversationFlow(agent);
      expect(reParsed.paths[0].dataChain[0].conversationPrompt).toBe(origPrompt);
    });
  });

  describe("multi-path operations", () => {
    it("regenerates one path without affecting the other", () => {
      const { agent } = generateMultiPath();
      const parsed = parseConversationFlow(agent);
      const residential = parsed.paths.find(p => p.name === "Residential")!;
      const commercialBefore = parsed.paths.find(p => p.name === "Commercial")!;
      const commercialVarsBefore = getPathVariableNames(commercialBefore);

      // Add city to residential
      const dps = [...dataPointsFromChain(residential.dataChain), TEST_DEFAULTS.city];
      const result = regenerateDataChain(residential, dps, parsed.closeNode!.id, "Residential");
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      const newResidential = reParsed.paths.find(p => p.name === "Residential")!;
      const newCommercial = reParsed.paths.find(p => p.name === "Commercial")!;

      expect(newResidential.dataChain).toHaveLength(3);
      expect(getPathVariableNames(newCommercial)).toEqual(commercialVarsBefore);
    });

    it("adds path name suffix to node names", () => {
      const { agent } = generateMultiPath();
      const parsed = parseConversationFlow(agent);
      const residential = parsed.paths.find(p => p.name === "Residential")!;

      const dps = dataPointsFromChain(residential.dataChain);
      const result = regenerateDataChain(residential, dps, parsed.closeNode!.id, "Residential");

      const routerNode = result.newNodes.find(n => (n as any).type === "branch");
      expect((routerNode as any)?.name).toContain("(Residential)");

      const extractNode = result.newNodes.find(n =>
        (n as any).type === "extract_dynamic_variables" &&
        (n as any).name.startsWith("Extract All"));
      expect((extractNode as any)?.name).toContain("(Residential)");
    });
  });

  describe("special data point handling", () => {
    it("handles phone_number with collected flag", () => {
      const { agent } = generateSinglePath(["phone_number", "full_name"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];

      // Regenerate with same data points
      const dps = dataPointsFromChain(path.dataChain);
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

      // Check phone_number router edge has special equations
      const flow = agent.conversationFlow as any;
      const router = flow.nodes.find((n: any) => n.name === "Variables Router");
      const phoneEdge = router.edges[0];
      const eqs = phoneEdge.transition_condition.equations;
      expect(eqs.some((eq: any) => eq.left === "{{phone_number_collected}}")).toBe(true);
    });

    it("handles composite scheduling data point", () => {
      const { agent } = generateSinglePath(["full_name", "scheduling"]);
      const parsed = parseConversationFlow(agent);
      const path = parsed.paths[0];

      // Add another data point after scheduling
      const dps = [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city];
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id);
      applyRegeneratedChain(agent, result);

      expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
      const reParsed = parseConversationFlow(agent);
      expect(reParsed.paths[0].dataChain).toHaveLength(3);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUND-TRIP INTEGRITY TESTS
// These verify that generate → parse → regenerate → validate → parse produces
// consistent results — the most critical tests for preventing corruption.
// ═══════════════════════════════════════════════════════════════════════════════

describe("round-trip integrity", () => {
  it("generate → parse → regenerate → validate is lossless for single-path", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    const origVars = getPathVariableNames(path);

    // Regenerate with identical data
    const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);

    const errors = validateConversationFlow(agent.conversationFlow as any);
    expect(errors).toEqual([]);

    const reParsed = parseConversationFlow(agent);
    expect(getPathVariableNames(reParsed.paths[0])).toEqual(origVars);
  });

  it("generate → parse → regenerate → validate is lossless for multi-path", () => {
    const { agent } = generateMultiPath();
    const parsed = parseConversationFlow(agent);

    for (const path of parsed.paths) {
      const origVars = getPathVariableNames(path);
      const result = regenerateDataChain(
        path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id,
        path.name === "Default" ? undefined : path.name,
      );
      applyRegeneratedChain(agent, result);

      const errors = validateConversationFlow(agent.conversationFlow as any);
      expect(errors).toEqual([]);

      const reParsed = parseConversationFlow(agent);
      const newPath = reParsed.paths.find(p => p.name === path.name)!;
      expect(getPathVariableNames(newPath)).toEqual(origVars);
    }
  });

  it("add → remove yields original structure", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const origFlow = JSON.parse(JSON.stringify(agent.conversationFlow));

    // Add city
    let parsed = parseConversationFlow(agent);
    let path = parsed.paths[0];
    let dps = [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city];
    let result = regenerateDataChain(path, dps, parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Verify city was added
    parsed = parseConversationFlow(agent);
    expect(parsed.paths[0].dataChain).toHaveLength(3);

    // Remove city
    path = parsed.paths[0];
    dps = dataPointsFromChain(path.dataChain).filter(dp => dp.variableName !== "city");
    result = regenerateDataChain(path, dps, parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Verify back to 2
    parsed = parseConversationFlow(agent);
    expect(getPathVariableNames(parsed.paths[0])).toEqual(["full_name", "phone_number"]);
  });

  it("multiple sequential edits maintain validity", () => {
    const { agent } = generateSinglePath(["full_name"]);

    // Add phone_number
    let parsed = parseConversationFlow(agent);
    let path = parsed.paths[0];
    let result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.phone_number], parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Add city
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city], parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Add email
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.email], parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Remove phone_number
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    result = regenerateDataChain(path, dataPointsFromChain(path.dataChain).filter(dp => dp.variableName !== "phone_number"), parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Reorder remaining
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    const dps = dataPointsFromChain(path.dataChain);
    result = regenerateDataChain(path, dps.reverse(), parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Final validation
    parsed = parseConversationFlow(agent);
    expect(parsed.paths[0].dataChain).toHaveLength(3);
    expect(parsed.introNode.name).toBe("Intro");
    expect(parsed.faqNode?.name).toBe("Admin/FAQ");
  });

  it("router else_edge always points to close node after regeneration", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    const closeId = parsed.closeNode!.id;

    const result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city], closeId);
    applyRegeneratedChain(agent, result);

    const flow = agent.conversationFlow as any;
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");
    expect(router.else_edge.destination_node_id).toBe(closeId);
  });

  it("front extract node contains all variables after add", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];

    const result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city], parsed.closeNode!.id);
    applyRegeneratedChain(agent, result);

    const flow = agent.conversationFlow as any;
    const extractAll = flow.nodes.find((n: any) => n.name === "Extract All Variables");
    const varNames = extractAll.variables.map((v: any) => v.name);
    expect(varNames).toContain("full_name");
    expect(varNames).toContain("city");
  });

  it("confirm nodes have tapered variable lists", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];

    const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id);

    // First confirm (full_name) should have 3 variables (full_name + phone_number + city)
    const confirmNodes = result.newNodes.filter(n => (n as any).type === "extract_dynamic_variables" && (n as any).name.startsWith("Confirm"));
    const firstConfirm = confirmNodes.find(n => (n as any).name === "Confirm Full Name");
    const lastConfirm = confirmNodes.find(n => (n as any).name === "Confirm City");

    expect((firstConfirm as any).variables.length).toBeGreaterThanOrEqual(3);
    expect((lastConfirm as any).variables.length).toBeGreaterThanOrEqual(1);
    // Last confirm should have fewer variables than first
    expect((lastConfirm as any).variables.length).toBeLessThan((firstConfirm as any).variables.length);
  });
});
