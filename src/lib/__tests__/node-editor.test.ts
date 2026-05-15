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
import { buildDataPointsFromChain, dedupDataPointKeys } from "../../routes/dashboard/node-editor.js";

// Shortcut: every regenerateDataChain call needs the Close Question id
// for the Variables Router's "_close_was_said" shortcut edge.
function cqId(parsed: ReturnType<typeof parseConversationFlow>): string {
  return parsed.closingNodes.find((n) => n.name === "Close Question")!.id;
}

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
    // Emergency Guard Rail removed — Retell ships built-in emergency
    // guardrails so the bespoke node was redundant.
    expect(globalNames).not.toContain("Emergency Gaurd Rail");
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
    expect(nodeNames).toContain("Live Transfer Recovery");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORPHAN DATA POINTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("orphan data points", () => {
  it("generate agent with orphan DP — no Collect/Confirm nodes for it", () => {
    const { agent } = generateAgent(baseConfig, [
      "full_name",
      { variableName: "is_loaded", type: "boolean" as const, description: "Is loaded", orphan: true,
        label: "Is Loaded", conversationPrompt: "", forwardCondition: "",
        finetuneExamples: [], extractSuccessEquation: [{ left: "{{is_loaded}}", operator: "exists" }] },
    ], undefined, TEST_DEFAULTS);

    const nodes = (agent.conversationFlow as any).nodes as any[];
    const nodeNames = nodes.map((n: any) => n.name);
    // Should have Collect Full Name but NOT Collect Is Loaded
    expect(nodeNames.some((n: string) => n.includes("Full Name") && n.includes("Collect"))).toBe(true);
    expect(nodeNames.some((n: string) => n.includes("Is Loaded") && n.includes("Collect"))).toBe(false);
  });

  it("orphan variable appears in front extract node", () => {
    const { agent } = generateAgent(baseConfig, [
      "full_name",
      { variableName: "is_loaded", type: "boolean" as const, description: "Is loaded", orphan: true,
        label: "Is Loaded", conversationPrompt: "", forwardCondition: "",
        finetuneExamples: [], extractSuccessEquation: [{ left: "{{is_loaded}}", operator: "exists" }] },
    ], undefined, TEST_DEFAULTS);

    const nodes = (agent.conversationFlow as any).nodes as any[];
    const extractNode = nodes.find((n: any) => n.type === "extract_dynamic_variables" && n.name.includes("Extract"));
    expect(extractNode).toBeDefined();
    const varNames = (extractNode.variables as any[]).map((v: any) => v.name);
    expect(varNames).toContain("is_loaded");
    expect(varNames).toContain("full_name");
  });

  it("orphan variable not in router edges", () => {
    const { agent } = generateAgent(baseConfig, [
      "full_name",
      { variableName: "is_loaded", type: "boolean" as const, description: "Is loaded", orphan: true,
        label: "Is Loaded", conversationPrompt: "", forwardCondition: "",
        finetuneExamples: [], extractSuccessEquation: [{ left: "{{is_loaded}}", operator: "exists" }] },
    ], undefined, TEST_DEFAULTS);

    const nodes = (agent.conversationFlow as any).nodes as any[];
    const router = nodes.find((n: any) => n.type === "branch" && n.name.includes("Router"));
    expect(router).toBeDefined();
    // Router should have 1 DP edge (full_name, not the orphan) + 1
    // _close_was_said shortcut = 2 total. Orphan still does NOT get an
    // edge — that's the regression this test guards.
    expect(router.edges).toHaveLength(2);
    // First edge is the DP edge; last is the close-said shortcut.
    expect(router.edges[router.edges.length - 1].transition_condition.equations[0].left).toBe("{{_close_was_said}}");
  });

  it("validates successfully with orphan data point", () => {
    const { agent } = generateAgent(baseConfig, [
      "full_name",
      { variableName: "is_loaded", type: "boolean" as const, description: "Is loaded", orphan: true,
        label: "Is Loaded", conversationPrompt: "", forwardCondition: "",
        finetuneExamples: [], extractSuccessEquation: [{ left: "{{is_loaded}}", operator: "exists" }] },
    ], undefined, TEST_DEFAULTS);

    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
  });

  it("parser detects orphan variables from front extract", () => {
    const { agent } = generateAgent(baseConfig, [
      "full_name",
      { variableName: "is_loaded", type: "boolean" as const, description: "Is loaded", orphan: true,
        label: "Is Loaded", conversationPrompt: "", forwardCondition: "",
        finetuneExamples: [], extractSuccessEquation: [{ left: "{{is_loaded}}", operator: "exists" }] },
    ], undefined, TEST_DEFAULTS);

    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    // Should have 2 data points: full_name (normal) + is_loaded (orphan)
    expect(path.dataChain).toHaveLength(2);
    const orphan = path.dataChain.find((dp) => dp.variableName === "is_loaded");
    expect(orphan).toBeDefined();
    expect(orphan!.orphan).toBe(true);
    expect(orphan!.conversationPrompt).toBe("");
  });

  it("round-trip: generate → parse → regenerate with orphan preserved", () => {
    const { agent } = generateAgent(baseConfig, [
      "full_name",
      { variableName: "is_loaded", type: "boolean" as const, description: "Is loaded", orphan: true,
        label: "Is Loaded", conversationPrompt: "", forwardCondition: "",
        finetuneExamples: [], extractSuccessEquation: [{ left: "{{is_loaded}}", operator: "exists" }] },
    ], undefined, TEST_DEFAULTS);

    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];
    const dps = dataPointsFromChain(path.dataChain);
    // Preserve orphan flag
    for (const dp of dps) {
      const parsedDp = path.dataChain.find((p) => p.variableName === dp.variableName);
      if (parsedDp?.orphan) dp.orphan = true;
    }

    const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);

    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    const reParsed = parseConversationFlow(agent);
    expect(reParsed.paths[0].dataChain).toHaveLength(2);
    const reOrphan = reParsed.paths[0].dataChain.find((dp) => dp.variableName === "is_loaded");
    expect(reOrphan?.orphan).toBe(true);
  });
});

describe("dedupDataPointKeys (regression for `Duplicate variable` save bug)", () => {
  it("drops later-occurrence duplicate string keys, preserving order", () => {
    expect(dedupDataPointKeys(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("dedups object items by variableName", () => {
    expect(
      dedupDataPointKeys([
        { variableName: "a" },
        { variableName: "b", _branchConditions: [] },
        { variableName: "a", _branchConditions: [{}] },
      ]),
    ).toEqual([{ variableName: "a" }, { variableName: "b", _branchConditions: [] }]);
  });

  it("leaves a list with no duplicates unchanged", () => {
    const input = ["a", "b", "c"];
    expect(dedupDataPointKeys(input)).toEqual(input);
  });

  it("passes through items missing a variableName (no-op for branch nodes)", () => {
    const branch = { _branch: true, variable: "x", operator: "==", value: "y" };
    expect(dedupDataPointKeys(["a", branch, "a", branch])).toEqual(["a", branch, branch]);
  });
});

describe("Close node defaults", () => {
  it("single-path Close node has interruption_sensitivity: 0 (no interruption)", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const flow = agent.conversationFlow as { nodes: Array<Record<string, unknown>> };
    const closeNodes = flow.nodes.filter((n) => n.name === "Close");
    expect(closeNodes.length).toBe(1);
    expect(closeNodes[0].interruption_sensitivity).toBe(0);
  });

  it("multi-path agents emit interruption_sensitivity: 0 on every per-path Close node", () => {
    const { agent } = generateMultiPath();
    const flow = agent.conversationFlow as { nodes: Array<Record<string, unknown>> };
    const closeNodes = flow.nodes.filter((n) =>
      typeof n.name === "string" && (n.name as string).startsWith("Close (")
    );
    expect(closeNodes.length).toBe(2); // Residential + Commercial
    for (const close of closeNodes) {
      expect(close.interruption_sensitivity, `${close.name} should block interruption`).toBe(0);
    }
  });
});

describe("composite parsing with orphan persistence (regression)", () => {
  it("composite Confirm doesn't include persistent orphan vars (sub-var lumping bug)", () => {
    // The user's bug: an orphan dp (hvac_service_type) following a
    // composite dp (scheduling) was getting injected into the composite's
    // Confirm extract (orphan persistence) and then parsed as a 3rd sub-var
    // of "Day / Time Preference". Fix: composites skip orphan persistence
    // so the parser keeps treating Confirm.variables as the canonical
    // sub-var list.
    const orphanDp: DataPoint = {
      label: "HVAC Service Type",
      variableName: "hvac_service_type",
      type: "enum",
      choices: ["maintenance", "repair", NOT_MENTIONED],
      description: `hvac_service_type. If not mentioned, set to "${NOT_MENTIONED}".`,
      conversationPrompt: "",
      forwardCondition: "",
      finetuneExamples: [],
      extractSuccessEquation: defaultExtractEquation("hvac_service_type"),
      orphan: true,
    };
    const { agent } = generateAgent(
      baseConfig,
      ["full_name", "scheduling", "hvac_service_type"],
      undefined,
      { ...TEST_DEFAULTS, hvac_service_type: orphanDp },
    );
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];

    const scheduling = path.dataChain.find((d) => d.collectNode.name === "Day / Time Preference");
    expect(scheduling).toBeDefined();
    const subVarNames = scheduling!.variableDefs.map((v) => v.name);
    expect(subVarNames).toEqual(["preferred_day", "preferred_time"]);
    expect(subVarNames).not.toContain("hvac_service_type");

    const hvac = path.dataChain.find((d) => d.variableName === "hvac_service_type");
    expect(hvac).toBeDefined();
    expect(hvac!.orphan).toBe(true);
  });

  it("non-composite Confirm extracts still persist orphan vars across the chain", () => {
    // The flip side: orphan persistence MUST still work for non-composite
    // dps so the agent has the maximum capture window for spontaneously-
    // mentioned values.
    const orphanDp: DataPoint = {
      label: "Loaded?",
      variableName: "is_loaded",
      type: "boolean",
      choices: [],
      description: `is_loaded. If not mentioned, set to "${NOT_MENTIONED}".`,
      conversationPrompt: "",
      forwardCondition: "",
      finetuneExamples: [],
      extractSuccessEquation: defaultExtractEquation("is_loaded"),
      orphan: true,
    };
    const { agent } = generateAgent(
      baseConfig,
      ["full_name", "phone_number", "is_loaded"],
      undefined,
      { ...TEST_DEFAULTS, is_loaded: orphanDp },
    );
    // Find the phone_number Confirm node — its variables list should
    // include is_loaded (persistent orphan) alongside phone_number itself.
    const flow = agent.conversationFlow as { nodes: Array<Record<string, unknown>> };
    const confirmPhone = flow.nodes.find((n) => n.name === "Confirm Phone Number");
    expect(confirmPhone).toBeDefined();
    const vars = (confirmPhone!.variables as Array<{ name: string }>).map((v) => v.name);
    expect(vars).toContain("phone_number");
    expect(vars).toContain("is_loaded");
  });
});

describe("parser orphan placement (regression — HVAC Default reversal)", () => {
  // Reproducer for the user-reported bug: an orphan dp placed mid-chain
  // was being appended to the END of dataChain (and silently dropped from
  // steps) at parse time, so the Node Editor showed it at the bottom of the
  // routing pad — not where the operator placed it. Saving from there
  // pushed the wrong order back to Retell.

  const orphanInMiddle: DataPoint = {
    label: "Service Type",
    variableName: "hvac_service_type",
    type: "enum",
    choices: ["maintenance", "repair", NOT_MENTIONED],
    description: `hvac_service_type. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "",
    forwardCondition: "",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("hvac_service_type"),
    orphan: true,
  };

  it("preserves orphan position in dataChain and steps", () => {
    const { agent } = generateAgent(
      baseConfig,
      ["full_name", "phone_number", "hvac_service_type", "city"],
      undefined,
      { ...TEST_DEFAULTS, hvac_service_type: orphanInMiddle },
    );
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];

    const chainNames = path.dataChain.map((dp) => dp.variableName);
    expect(chainNames).toEqual([
      "full_name",
      "phone_number",
      "hvac_service_type",
      "city",
    ]);

    const stepNames = path.steps.map((s) =>
      s.kind === "dp" ? s.dp.variableName : `<sms:${s.action.displayName}>`,
    );
    expect(stepNames).toEqual([
      "full_name",
      "phone_number",
      "hvac_service_type",
      "city",
    ]);

    const hvac = path.dataChain.find((d) => d.variableName === "hvac_service_type");
    expect(hvac?.orphan).toBe(true);
    // Sanity: hvac dp should only appear once in the chain.
    const hvacCount = path.dataChain.filter((d) => d.variableName === "hvac_service_type").length;
    expect(hvacCount).toBe(1);
  });

  it("buildDataPointsFromChain returns the orphan at its source position", () => {
    const { agent } = generateAgent(
      baseConfig,
      ["full_name", "phone_number", "hvac_service_type", "city"],
      undefined,
      { ...TEST_DEFAULTS, hvac_service_type: orphanInMiddle },
    );
    const parsed = parseConversationFlow(agent);
    const dps = buildDataPointsFromChain(parsed.paths[0], {
      ...TEST_DEFAULTS,
      hvac_service_type: orphanInMiddle,
    });
    expect(dps.map((d) => d.variableName)).toEqual([
      "full_name",
      "phone_number",
      "hvac_service_type",
      "city",
    ]);
  });

  it("multi-orphan source order is preserved", () => {
    const orphanEmail: DataPoint = {
      label: "Email",
      variableName: "caller_email",
      type: "string",
      description: `caller_email. If not mentioned, set to "${NOT_MENTIONED}".`,
      conversationPrompt: "",
      forwardCondition: "",
      finetuneExamples: [],
      extractSuccessEquation: defaultExtractEquation("caller_email"),
      orphan: true,
    };
    const { agent } = generateAgent(
      baseConfig,
      ["full_name", "hvac_service_type", "phone_number", "caller_email"],
      undefined,
      {
        ...TEST_DEFAULTS,
        hvac_service_type: orphanInMiddle,
        caller_email: orphanEmail,
      },
    );
    const parsed = parseConversationFlow(agent);
    expect(parsed.paths[0].dataChain.map((d) => d.variableName)).toEqual([
      "full_name",
      "hvac_service_type",
      "phone_number",
      "caller_email",
    ]);
    expect(
      parsed.paths[0].steps.map((s) => (s.kind === "dp" ? s.dp.variableName : "sms")),
    ).toEqual([
      "full_name",
      "hvac_service_type",
      "phone_number",
      "caller_email",
    ]);
  });
});

describe("buildDataPointsFromChain — orphan flag propagation (regression)", () => {
  it("propagates orphan from the parser-detected orphan dp", () => {
    // Build an agent where `is_loaded` is orphan from the start. Parse it,
    // then run buildDataPointsFromChain — the orphan flag must survive.
    const { agent } = generateAgent(baseConfig, [
      "full_name",
      { variableName: "is_loaded", type: "boolean" as const, description: "Is loaded", orphan: true,
        label: "Is Loaded", conversationPrompt: "", forwardCondition: "",
        finetuneExamples: [], extractSuccessEquation: [{ left: "{{is_loaded}}", operator: "exists" }] },
    ], undefined, TEST_DEFAULTS);
    const parsed = parseConversationFlow(agent);
    const dps = buildDataPointsFromChain(parsed.paths[0], TEST_DEFAULTS);
    const isLoadedDp = dps.find((d) => d.variableName === "is_loaded");
    expect(isLoadedDp?.orphan).toBe(true);
  });

  it("propagates orphan from the global default even when the parsed chain still has Collect/Confirm (the user's bug)", () => {
    // Scenario: dp was originally generated as normal (full Collect/Confirm),
    // then the operator flipped it to orphan in global settings. Parser still
    // sees a normal chain dp (no orphan flag on it), so without this fix the
    // resulting DataPoint would have orphan=undefined and the regenerator
    // would (a) generate a Collect with empty instruction text, (b) reuse
    // the placeholder front-extract id for it → "Duplicate node id" plus
    // "empty instruction text" validation failures.
    const normalThenOrphan: DataPoint = {
      label: "Service Type",
      variableName: "hvac_service_type",
      type: "enum",
      choices: ["maintenance", "repair", NOT_MENTIONED],
      description: `hvac_service_type. If not mentioned, set to "${NOT_MENTIONED}".`,
      conversationPrompt: "Ask about HVAC type.",
      forwardCondition: "Caller provided HVAC type.",
      finetuneExamples: [],
      extractSuccessEquation: defaultExtractEquation("hvac_service_type"),
    };
    const { agent } = generateAgent(baseConfig, ["full_name", "hvac_service_type"], undefined, {
      ...TEST_DEFAULTS,
      hvac_service_type: normalThenOrphan,
    });
    const parsed = parseConversationFlow(agent);

    // Now the operator marks it orphan in global settings — defaults reflect that.
    const updatedDefaults: Record<string, DataPoint> = {
      ...TEST_DEFAULTS,
      hvac_service_type: { ...normalThenOrphan, orphan: true },
    };
    const dps = buildDataPointsFromChain(parsed.paths[0], updatedDefaults);
    const hvacDp = dps.find((d) => d.variableName === "hvac_service_type");
    expect(hvacDp?.orphan).toBe(true);

    // End-to-end: feed back into the regenerator and confirm the canonical
    // validates clean (no duplicate ids, no empty Collect text).
    const result = regenerateDataChain(parsed.paths[0], dps, parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);
    // And: there should NOT be a Collect node for hvac_service_type after regen.
    const reParsed = parseConversationFlow(agent);
    const reChainDp = reParsed.paths[0].dataChain.find((d) => d.variableName === "hvac_service_type");
    expect(reChainDp?.orphan).toBe(true);
    const allNodes = (agent.conversationFlow as any).nodes as Array<Record<string, unknown>>;
    const collectForHvac = allNodes.find((n) => n.name === "Collect Service Type" || n.name === "Collect HVAC Service Type" || n.name === "Collect Hvac Service Type");
    expect(collectForHvac).toBeUndefined();
  });

  it("leaves orphan: undefined when neither parser nor defaults mark it orphan", () => {
    const { agent } = generateAgent(baseConfig, ["full_name", "phone_number"], undefined, TEST_DEFAULTS);
    const parsed = parseConversationFlow(agent);
    const dps = buildDataPointsFromChain(parsed.paths[0], TEST_DEFAULTS);
    expect(dps.every((d) => !d.orphan)).toBe(true);
  });
});

describe("buildDataPointsFromChain — workspace-default fine-tune propagation", () => {
  // Regression for the bug where workspace-default fine-tunes added in the
  // global-settings dashboard never reached published agents. The dashboard
  // save-and-publish path calls buildDataPointsFromChain to reconstruct
  // DataPoint[] from the existing canonical flow; that result is fed into
  // regenerateDataChain. If we don't pull defaults.finetuneExamples here,
  // the regenerator has nothing to write onto the new Collect node.

  it("pulls finetuneExamples from the workspace default", () => {
    const customFt = {
      type: "negative" as const,
      transcript: [{ role: "user" as const, content: "Just call me Smith." }, { role: "agent" as const, content: "And your first name?" }],
    };
    const defaults: Record<string, DataPoint> = {
      ...TEST_DEFAULTS,
      full_name: { ...TEST_DEFAULTS.full_name, finetuneExamples: [customFt] },
    };
    // The fixture agent was created with the OLD defaults (no FT). The
    // dashboard editor reloads with the NEW defaults — buildDataPointsFromChain
    // should now surface the new FT so the regenerator can publish it.
    const { agent } = generateAgent(baseConfig, ["full_name", "phone_number"], undefined, TEST_DEFAULTS);
    const parsed = parseConversationFlow(agent);
    const dps = buildDataPointsFromChain(parsed.paths[0], defaults);

    const fullName = dps.find((d) => d.variableName === "full_name");
    expect(fullName?.finetuneExamples).toHaveLength(1);
    expect(fullName?.finetuneExamples?.[0].transcript[0].content).toBe("Just call me Smith.");
  });

  it("end-to-end: new defaults propagate to the regenerated Collect node", () => {
    const customFt = {
      type: "negative" as const,
      transcript: [{ role: "user" as const, content: "GOLDEN-CANARY-PHRASE" }, { role: "agent" as const, content: "ack" }],
    };
    const { agent } = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS);
    const parsed = parseConversationFlow(agent);

    // Operator added a FT to the workspace default since the agent was created.
    const updatedDefaults: Record<string, DataPoint> = {
      ...TEST_DEFAULTS,
      full_name: { ...TEST_DEFAULTS.full_name, finetuneExamples: [customFt] },
    };
    const dps = buildDataPointsFromChain(parsed.paths[0], updatedDefaults);

    const result = regenerateDataChain(parsed.paths[0], dps, parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);

    // The regenerated Collect node should carry the new FT, not the old (empty) one.
    const flow = agent.conversationFlow as { nodes: Array<Record<string, any>> };
    const collectFullName = flow.nodes.find((n) => n.name === "Collect Full Name");
    const ftes = (collectFullName?.finetune_transition_examples as any[]) ?? [];
    expect(ftes).toHaveLength(1);
    expect(ftes[0].transcript[0].content).toBe("GOLDEN-CANARY-PHRASE");
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

      const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id, cqId(parsed));
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
      const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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

      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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
      const result = regenerateDataChain(residential, dps, parsed.closeNode!.id, cqId(parsed), "Residential");
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
      const result = regenerateDataChain(residential, dps, parsed.closeNode!.id, cqId(parsed), "Residential");

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
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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
      const result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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
    const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id, cqId(parsed));
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
      // Multi-path callback agents have a per-path Close — route the
      // regenerated data chain to *that* close, not the first one found.
      const terminalId = path.closeNode?.id ?? parsed.closeNode!.id;
      const result = regenerateDataChain(
        path, dataPointsFromChain(path.dataChain), terminalId,
        cqId(parsed),
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
    let result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Verify city was added
    parsed = parseConversationFlow(agent);
    expect(parsed.paths[0].dataChain).toHaveLength(3);

    // Remove city
    path = parsed.paths[0];
    dps = dataPointsFromChain(path.dataChain).filter(dp => dp.variableName !== "city");
    result = regenerateDataChain(path, dps, parsed.closeNode!.id, cqId(parsed));
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
    let result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.phone_number], parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Add city
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city], parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Add email
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.email], parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Remove phone_number
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    result = regenerateDataChain(path, dataPointsFromChain(path.dataChain).filter(dp => dp.variableName !== "phone_number"), parsed.closeNode!.id, cqId(parsed));
    applyRegeneratedChain(agent, result);
    expect(validateConversationFlow(agent.conversationFlow as any)).toEqual([]);

    // Reorder remaining
    parsed = parseConversationFlow(agent);
    path = parsed.paths[0];
    const dps = dataPointsFromChain(path.dataChain);
    result = regenerateDataChain(path, dps.reverse(), parsed.closeNode!.id, cqId(parsed));
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

    const result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city], closeId, cqId(parsed));
    applyRegeneratedChain(agent, result);

    const flow = agent.conversationFlow as any;
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");
    expect(router.else_edge.destination_node_id).toBe(closeId);
  });

  it("front extract node contains all variables after add", () => {
    const { agent } = generateSinglePath(["full_name"]);
    const parsed = parseConversationFlow(agent);
    const path = parsed.paths[0];

    const result = regenerateDataChain(path, [...dataPointsFromChain(path.dataChain), TEST_DEFAULTS.city], parsed.closeNode!.id, cqId(parsed));
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

    const result = regenerateDataChain(path, dataPointsFromChain(path.dataChain), parsed.closeNode!.id, cqId(parsed));

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

// ── Per-path end mode round-trip ─────────────────────────────────────────────

describe("parser: per-path end mode", () => {
  it("parses callback-mode paths as endMode='callback'", () => {
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "A", transitionCondition: "A", dataPoints: ["full_name"] },
        { name: "B", transitionCondition: "B", dataPoints: ["city"] },
      ],
      TEST_DEFAULTS,
    );
    const parsed = parseConversationFlow(agent as any);
    expect(parsed.paths).toHaveLength(2);
    for (const p of parsed.paths) {
      expect(p.endMode).toBe("callback");
      expect(p.preTransferNode).toBeUndefined();
      expect(p.transferCallNode).toBeUndefined();
    }
  });

  it("parses transfer-mode paths as endMode='transfer' with destination", () => {
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "Emergency", transitionCondition: "x", dataPoints: ["full_name"], endMode: "transfer", transferDestination: "+18005550000" },
        { name: "Quote", transitionCondition: "y", dataPoints: ["city"] },
      ],
      TEST_DEFAULTS,
    );
    const parsed = parseConversationFlow(agent as any);
    const emergency = parsed.paths.find(p => p.name === "Emergency");
    const quote = parsed.paths.find(p => p.name === "Quote");
    expect(emergency?.endMode).toBe("transfer");
    expect(emergency?.transferDestination).toBe("+18005550000");
    expect(emergency?.preTransferNode).toBeDefined();
    expect(emergency?.transferCallNode).toBeDefined();
    expect(quote?.endMode).toBe("callback");
  });
});

describe("regenerator: respects per-path end mode", () => {
  it("rewires variables router → existing pre-transfer (not close) when path is transfer-mode", () => {
    // Use multi-path so per-path node-name suffixes are applied (single-path
    // mode shares unsuffixed nodes; the parser would label that path "Default").
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "Emergency", transitionCondition: "x", dataPoints: ["full_name"], endMode: "transfer", transferDestination: "+18005550000" },
        { name: "Quote", transitionCondition: "y", dataPoints: ["city"] },
      ],
      TEST_DEFAULTS,
    );
    const parsed = parseConversationFlow(agent as any);
    const emergency = parsed.paths.find(p => p.name === "Emergency")!;
    expect(emergency).toBeDefined();
    expect(emergency.endMode).toBe("transfer");

    // Regenerate the chain with an extra data point.
    const newChain = [
      { variableName: "full_name", label: "Full Name", type: "string", description: "", conversationPrompt: "", forwardCondition: "", finetuneExamples: [], extractSuccessEquation: defaultExtractEquation("full_name") },
      { variableName: "phone_number", label: "Phone Number", type: "string", description: "", conversationPrompt: "", forwardCondition: "", finetuneExamples: [], extractSuccessEquation: defaultExtractEquation("phone_number") },
    ] as DataPoint[];

    const result = regenerateDataChain(emergency, newChain, parsed.closeNode!.id, cqId(parsed), "Emergency");
    const router = result.newNodes.find((n: any) => n.name === "Variables Router (Emergency)") as any;
    // Else_edge must point to the path's existing Pre-Transfer node, NOT the Close node.
    expect(router.else_edge.destination_node_id).toBe(emergency.preTransferNode!.id);
    expect(router.else_edge.destination_node_id).not.toBe(parsed.closeNode!.id);
  });
});
