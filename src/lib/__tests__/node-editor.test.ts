import { describe, it, expect } from "vitest";
import {
  generateAgent,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  defaultExtractEquation,
  type DataPoint,
} from "../agent-generator/index.js";
import { parseConversationFlow, getPathVariableNames, getPathNodeIds } from "../node-parser.js";
import { validateConversationFlow } from "../node-validator.js";
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
};

function generateSinglePath(dpKeys: string[]) {
  return generateAgent(
    baseConfig,
    dpKeys,
    undefined,
    TEST_DEFAULTS,
  );
}

function generateMultiPath() {
  return generateAgent(
    baseConfig,
    [],
    [
      {
        name: "Residential",
        transitionCondition: "Caller needs residential service",
        dataPoints: ["full_name", "phone_number"],
      },
      {
        name: "Commercial",
        transitionCondition: "Caller needs commercial service",
        dataPoints: ["full_name", "city"],
      },
    ],
    TEST_DEFAULTS,
  );
}

// ── Node Parser Tests ────────────────────────────────────────────────────────

describe("parseConversationFlow", () => {
  it("parses a single-path agent", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);

    expect(parsed.introNode).toBeDefined();
    expect(parsed.introNode.name).toBe("Intro");
    expect(parsed.faqNode).toBeDefined();
    expect(parsed.faqNode?.name).toBe("Admin/FAQ");
    expect(parsed.closeNode).toBeDefined();
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
  });

  it("parses a multi-path agent", () => {
    const { agent } = generateMultiPath();
    const parsed = parseConversationFlow(agent);

    expect(parsed.paths).toHaveLength(2);
    expect(parsed.paths[0].name).toBe("Residential");
    expect(parsed.paths[0].dataChain).toHaveLength(2);
    expect(parsed.paths[0].dataChain[0].variableName).toBe("full_name");
    expect(parsed.paths[0].dataChain[1].variableName).toBe("phone_number");

    expect(parsed.paths[1].name).toBe("Commercial");
    expect(parsed.paths[1].dataChain).toHaveLength(2);
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

  it("getPathVariableNames returns ordered variable names", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);

    const vars = getPathVariableNames(parsed.paths[0]);
    expect(vars).toEqual(["full_name", "phone_number", "city"]);
  });

  it("getPathNodeIds returns all node IDs in a path", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const parsed = parseConversationFlow(agent);

    const ids = getPathNodeIds(parsed.paths[0]);
    // transition + frontExtract + router + 2*(collect + confirm) = 7
    expect(ids.size).toBe(7);
  });
});

// ── Node Validator Tests ─────────────────────────────────────────────────────

describe("validateConversationFlow", () => {
  it("validates a correct single-path flow", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const flow = agent.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    expect(errors).toEqual([]);
  });

  it("validates a correct multi-path flow", () => {
    const { agent } = generateMultiPath();
    const flow = agent.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    expect(errors).toEqual([]);
  });

  it("catches missing start_node_id", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const flow = { ...(agent.conversationFlow as Record<string, unknown>) };
    delete flow.start_node_id;
    const errors = validateConversationFlow(flow);
    expect(errors.some((e) => e.code === "NO_START_NODE")).toBe(true);
  });

  it("catches empty global_prompt", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const flow = { ...(agent.conversationFlow as Record<string, unknown>) };
    flow.global_prompt = "";
    const errors = validateConversationFlow(flow);
    expect(errors.some((e) => e.code === "NO_GLOBAL_PROMPT")).toBe(true);
  });

  it("catches invalid edge destination", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const flow = agent.conversationFlow as Record<string, unknown>;
    const nodes = flow.nodes as Array<Record<string, unknown>>;
    // Corrupt an edge destination
    const introNode = nodes.find((n) => n.name === "Intro")!;
    const edges = introNode.edges as Array<Record<string, unknown>>;
    edges[0].destination_node_id = "nonexistent-node-id";

    const errors = validateConversationFlow(flow);
    expect(errors.some((e) => e.code === "EDGE_INVALID_DEST")).toBe(true);
  });

  it("catches missing nodes array", () => {
    const errors = validateConversationFlow({ global_prompt: "test", start_node_id: "x" });
    expect(errors.some((e) => e.code === "NO_NODES")).toBe(true);
  });

  it("catches conversation node without instruction", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const flow = agent.conversationFlow as Record<string, unknown>;
    const nodes = flow.nodes as Array<Record<string, unknown>>;
    const introNode = nodes.find((n) => n.name === "Intro")!;
    delete introNode.instruction;

    const errors = validateConversationFlow(flow);
    expect(errors.some((e) => e.code === "CONV_NO_INSTRUCTION")).toBe(true);
  });
});

// ── Node Regenerator Tests ───────────────────────────────────────────────────

describe("regenerateDataChain", () => {
  it("regenerates with same data points (preserves node IDs)", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    const closeNodeId = parsed.closeNode!.id;

    // Get existing IDs
    const origCollectId = path.dataChain[0].collectNode.id;
    const origConfirmId = path.dataChain[0].confirmNode.id;

    // Regenerate with same data points
    const dataPoints: DataPoint[] = path.dataChain.map((dp) => ({
      label: dp.label,
      variableName: dp.variableName,
      type: dp.variableDefs[0]?.type as DataPoint["type"] ?? "string",
      description: dp.variableDefs[0]?.description ?? "",
      conversationPrompt: dp.conversationPrompt,
      forwardCondition: dp.forwardCondition,
      finetuneExamples: [],
      extractSuccessEquation: defaultExtractEquation(dp.variableName),
    }));

    const result = regenerateDataChain(path, dataPoints, closeNodeId);

    // Existing node IDs should be preserved
    const newNodeIds = result.newNodes.map((n) => n.id);
    expect(newNodeIds).toContain(origCollectId);
    expect(newNodeIds).toContain(origConfirmId);
    expect(newNodeIds).toContain(path.frontExtractNode.id);
    expect(newNodeIds).toContain(path.routerNode.id);
  });

  it("adds a new data point", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    const closeNodeId = parsed.closeNode!.id;

    // Build current data points + new one
    const dataPoints: DataPoint[] = [
      ...path.dataChain.map((dp) => ({
        label: dp.label,
        variableName: dp.variableName,
        type: dp.variableDefs[0]?.type as DataPoint["type"] ?? "string",
        description: dp.variableDefs[0]?.description ?? "",
        conversationPrompt: dp.conversationPrompt,
        forwardCondition: dp.forwardCondition,
        finetuneExamples: [],
        extractSuccessEquation: defaultExtractEquation(dp.variableName),
      })),
      TEST_DEFAULTS.city,
    ];

    const result = regenerateDataChain(path, dataPoints, closeNodeId);
    applyRegeneratedChain(agent, result);

    // Validate the result
    const flow = agent.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    expect(errors).toEqual([]);

    // Re-parse and check
    const reParsed = parseConversationFlow(agent);
    expect(reParsed.paths[0].dataChain).toHaveLength(3);
    expect(reParsed.paths[0].dataChain[2].variableName).toBe("city");
  });

  it("removes a data point", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    const closeNodeId = parsed.closeNode!.id;

    // Remove phone_number
    const dataPoints: DataPoint[] = path.dataChain
      .filter((dp) => dp.variableName !== "phone_number")
      .map((dp) => ({
        label: dp.label,
        variableName: dp.variableName,
        type: dp.variableDefs[0]?.type as DataPoint["type"] ?? "string",
        description: dp.variableDefs[0]?.description ?? "",
        conversationPrompt: dp.conversationPrompt,
        forwardCondition: dp.forwardCondition,
        finetuneExamples: [],
        extractSuccessEquation: defaultExtractEquation(dp.variableName),
      }));

    const result = regenerateDataChain(path, dataPoints, closeNodeId);
    applyRegeneratedChain(agent, result);

    const flow = agent.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    expect(errors).toEqual([]);

    const reParsed = parseConversationFlow(agent);
    expect(reParsed.paths[0].dataChain).toHaveLength(2);
    const vars = reParsed.paths[0].dataChain.map((dp) => dp.variableName);
    expect(vars).toEqual(["full_name", "city"]);
  });

  it("reorders data points", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number", "city"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    const closeNodeId = parsed.closeNode!.id;

    // Reorder: city, full_name, phone_number
    const reordered = [path.dataChain[2], path.dataChain[0], path.dataChain[1]];
    const dataPoints: DataPoint[] = reordered.map((dp) => ({
      label: dp.label,
      variableName: dp.variableName,
      type: dp.variableDefs[0]?.type as DataPoint["type"] ?? "string",
      description: dp.variableDefs[0]?.description ?? "",
      conversationPrompt: dp.conversationPrompt,
      forwardCondition: dp.forwardCondition,
      finetuneExamples: [],
      extractSuccessEquation: defaultExtractEquation(dp.variableName),
    }));

    const result = regenerateDataChain(path, dataPoints, closeNodeId);
    applyRegeneratedChain(agent, result);

    const flow = agent.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    expect(errors).toEqual([]);

    const reParsed = parseConversationFlow(agent);
    const vars = reParsed.paths[0].dataChain.map((dp) => dp.variableName);
    expect(vars).toEqual(["city", "full_name", "phone_number"]);
  });

  it("preserves non-chain nodes when applying regeneration", () => {
    const { agent } = generateSinglePath(["full_name", "phone_number"]);
    const parsed = parseConversationFlow(agent);
    const totalNodesBefore = parsed.allNodes.length;

    const path = parsed.paths[0];
    const closeNodeId = parsed.closeNode!.id;

    // Add a data point (should increase node count by 2: collect + confirm)
    const dataPoints: DataPoint[] = [
      ...path.dataChain.map((dp) => ({
        label: dp.label,
        variableName: dp.variableName,
        type: dp.variableDefs[0]?.type as DataPoint["type"] ?? "string",
        description: dp.variableDefs[0]?.description ?? "",
        conversationPrompt: dp.conversationPrompt,
        forwardCondition: dp.forwardCondition,
        finetuneExamples: [],
        extractSuccessEquation: defaultExtractEquation(dp.variableName),
      })),
      TEST_DEFAULTS.city,
    ];

    const result = regenerateDataChain(path, dataPoints, closeNodeId);
    applyRegeneratedChain(agent, result);

    const reParsed = parseConversationFlow(agent);
    // Non-chain nodes (intro, FAQ, close, closing, guardrails, etc.) should remain
    expect(reParsed.introNode.name).toBe("Intro");
    expect(reParsed.faqNode?.name).toBe("Admin/FAQ");
    expect(reParsed.closeNode?.name).toBe("Close");
    expect(reParsed.globalNodes.length).toBeGreaterThan(0);

    // Total nodes should increase by 2 (new collect + new confirm)
    expect(reParsed.allNodes.length).toBe(totalNodesBefore + 2);
  });

  it("works with multi-path agents (regenerate one path)", () => {
    const { agent } = generateMultiPath();
    const parsed = parseConversationFlow(agent);

    const residentialPath = parsed.paths.find((p) => p.name === "Residential")!;
    const closeNodeId = parsed.closeNode!.id;

    // Add city to residential path
    const dataPoints: DataPoint[] = [
      ...residentialPath.dataChain.map((dp) => ({
        label: dp.label,
        variableName: dp.variableName,
        type: dp.variableDefs[0]?.type as DataPoint["type"] ?? "string",
        description: dp.variableDefs[0]?.description ?? "",
        conversationPrompt: dp.conversationPrompt,
        forwardCondition: dp.forwardCondition,
        finetuneExamples: [],
        extractSuccessEquation: defaultExtractEquation(dp.variableName),
      })),
      TEST_DEFAULTS.city,
    ];

    const result = regenerateDataChain(residentialPath, dataPoints, closeNodeId, "Residential");
    applyRegeneratedChain(agent, result);

    const flow = agent.conversationFlow as Record<string, unknown>;
    const errors = validateConversationFlow(flow);
    expect(errors).toEqual([]);

    const reParsed = parseConversationFlow(agent);
    const residential = reParsed.paths.find((p) => p.name === "Residential")!;
    const commercial = reParsed.paths.find((p) => p.name === "Commercial")!;

    expect(residential.dataChain).toHaveLength(3);
    expect(residential.dataChain[2].variableName).toBe("city");

    // Commercial path should be unchanged
    expect(commercial.dataChain).toHaveLength(2);
  });
});
