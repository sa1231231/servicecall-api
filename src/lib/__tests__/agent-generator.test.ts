import { describe, it, expect } from "vitest";
import {
  generateAgent,
  resolveDataPoints,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  PHONE_COLLECTED_FLAG,
  defaultExtractEquation,
  type DataPoint,
} from "../agent-generator/index.js";

const baseConfig = {
  businessName: "Test Co",
  faqKnowledgeBase: "FAQ content here",
  introFinetuneExamples: [],
};

// Test data points (simulates what MongoDB would provide)
const TEST_DEFAULTS: Record<string, DataPoint> = {
  full_name: {
    label: "Full Name",
    variableName: "full_name",
    type: "string",
    description: `Full name. If not mentioned, set to "${NOT_MENTIONED}". If they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: "Ask for the caller's name. If they don't know, move on.",
    forwardCondition: "The caller has given their name or indicated they don't know it",
    finetuneExamples: [
      { type: "negative", transcript: [{ content: "It's John.", role: "user" }, { content: "Got it, and your last name?", role: "agent" }] },
    ],
    extractSuccessEquation: defaultExtractEquation("full_name"),
  },
  phone_number: {
    label: "Phone Number",
    variableName: "phone_number",
    type: "string",
    description: `Phone number. If not mentioned, set to "${NOT_MENTIONED}". If they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: "Ask for their phone number. If they don't know, move on.",
    forwardCondition: "The caller has provided their phone number or indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("phone_number"),
  },
  city: {
    label: "City",
    variableName: "city",
    type: "string",
    description: `City. If not mentioned, set to "${NOT_MENTIONED}". If they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: "Ask for the city. If they don't know, move on.",
    forwardCondition: "The caller has given their city or indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("city"),
  },
  vehicle_type: {
    label: "Vehicle Type",
    variableName: "vehicle_type",
    type: "enum",
    choices: ["Semi", "Box truck", CALLER_DOESNT_KNOW, "Other", NOT_MENTIONED],
    description: `Vehicle type. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask what type of truck. If they don't know, move on.",
    forwardCondition: "The caller has provided the vehicle type or indicated they don't know it",
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
    conversationPrompt: "Ask when they want someone to come out. If they don't know, move on.",
    forwardCondition: "The caller has agreed to a day and time or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: [],
  },
};

// ── resolveDataPoints ────────────────────────────────────────────────────────

describe("resolveDataPoints", () => {
  it("resolves built-in string references", () => {
    const resolved = resolveDataPoints(["full_name", "phone_number"], TEST_DEFAULTS);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].variableName).toBe("full_name");
    expect(resolved[0].label).toBe("Full Name");
    expect(resolved[1].variableName).toBe("phone_number");
  });

  it("throws on unknown built-in reference", () => {
    expect(() => resolveDataPoints(["nonexistent"], TEST_DEFAULTS)).toThrow(
      /Unknown data point "nonexistent"/,
    );
  });

  it("resolves custom data point objects", () => {
    const resolved = resolveDataPoints([
      {
        variableName: "custom_field",
        label: "My Field",
        type: "string",
        description: "A custom field",
        conversationPrompt: "Ask for it",
        forwardCondition: "Caller provided it",
      },
    ], TEST_DEFAULTS);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].variableName).toBe("custom_field");
    expect(resolved[0].label).toBe("My Field");
  });

  it("fills defaults for partial custom objects", () => {
    const resolved = resolveDataPoints([{ variableName: "my_var" }], TEST_DEFAULTS);
    expect(resolved[0].label).toBe("My Var");
    expect(resolved[0].type).toBe("string");
    expect(resolved[0].conversationPrompt).toContain("my var");
    expect(resolved[0].extractSuccessEquation).toHaveLength(2);
  });

  it("throws when custom object missing variableName", () => {
    expect(() => resolveDataPoints([{ label: "No Name" } as any], TEST_DEFAULTS)).toThrow(
      /missing required field: variableName/,
    );
  });

  it("resolves composite data points", () => {
    const resolved = resolveDataPoints(["scheduling"], TEST_DEFAULTS);
    expect(resolved[0].composite).toBe(true);
    expect(resolved[0].variables).toHaveLength(2);
    expect(resolved[0].variables![0].variableName).toBe("preferred_day");
    expect(resolved[0].variables![1].variableName).toBe("preferred_time");
  });

  it("throws when defaults map is empty", () => {
    expect(() => resolveDataPoints(["full_name"], {})).toThrow(
      /No data point defaults provided/,
    );
  });

  it("custom data point objects bypass the defaults map", () => {
    const resolved = resolveDataPoints(
      [{ variableName: "inline_field", label: "Inline", type: "string", description: "inline desc", conversationPrompt: "ask", forwardCondition: "done" }],
      TEST_DEFAULTS,
    );
    expect(resolved[0].variableName).toBe("inline_field");
    expect(resolved[0].description).toBe("inline desc");
  });
});

describe("custom data point defaults include 'Caller Doesn\\'t Know' handling", () => {
  it("default description, conversationPrompt, and forwardCondition handle don't know", () => {
    const resolved = resolveDataPoints([{ variableName: "my_var" }], TEST_DEFAULTS);
    expect(resolved[0].description).toContain(CALLER_DOESNT_KNOW);
    expect(resolved[0].conversationPrompt).toMatch(/don't know/i);
    expect(resolved[0].forwardCondition).toMatch(/don't know/i);
  });
});

// ── orphan data points ──────────────────────────────────────────────────────

describe("orphan data points", () => {
  it("resolves orphan flag and sets empty prompt/condition", () => {
    const resolved = resolveDataPoints([
      { variableName: "is_location_specific", type: "boolean", description: "Location check", orphan: true },
    ], TEST_DEFAULTS);
    expect(resolved[0].orphan).toBe(true);
    expect(resolved[0].conversationPrompt).toBe("");
    expect(resolved[0].forwardCondition).toBe("");
  });

  it("orphan with explicit prompt preserves it", () => {
    const resolved = resolveDataPoints([
      { variableName: "custom_flag", orphan: true, conversationPrompt: "custom", forwardCondition: "custom" },
    ], TEST_DEFAULTS);
    expect(resolved[0].orphan).toBe(true);
    expect(resolved[0].conversationPrompt).toBe("custom");
    expect(resolved[0].forwardCondition).toBe("custom");
  });

  it("non-orphan gets default prompt when none provided", () => {
    const resolved = resolveDataPoints([{ variableName: "my_var" }], TEST_DEFAULTS);
    expect(resolved[0].orphan).toBeUndefined();
    expect(resolved[0].conversationPrompt).not.toBe("");
    expect(resolved[0].forwardCondition).not.toBe("");
  });

  it("orphan mixed with normal data points", () => {
    const resolved = resolveDataPoints([
      "full_name",
      { variableName: "is_loaded", type: "boolean", description: "Is loaded", orphan: true },
      "phone_number",
    ], TEST_DEFAULTS);
    expect(resolved).toHaveLength(3);
    expect(resolved[0].orphan).toBeUndefined();
    expect(resolved[1].orphan).toBe(true);
    expect(resolved[2].orphan).toBeUndefined();
  });
});

// ── generateAgent ───────────────────────────────────────────────────────────

describe("generateAgent", () => {
  it("generates agent with defaults", () => {
    const { resolved } = generateAgent(baseConfig, ["full_name", "city"], undefined, TEST_DEFAULTS);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].variableName).toBe("full_name");
    expect(resolved[1].variableName).toBe("city");
  });

  it("multi-path generation works", () => {
    const paths = [
      { name: "Path A", transitionCondition: "A", dataPoints: ["full_name"] as any[] },
      { name: "Path B", transitionCondition: "B", dataPoints: ["city"] as any[] },
    ];
    const { resolvedPaths } = generateAgent(baseConfig, [], paths, TEST_DEFAULTS);
    expect(resolvedPaths).toHaveLength(2);
    expect(resolvedPaths![0].resolved[0].variableName).toBe("full_name");
    expect(resolvedPaths![1].resolved[0].variableName).toBe("city");
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("router equations use NOT_MENTIONED constant value", () => {
    const { agent } = generateAgent(baseConfig, ["full_name", "city"], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");
    router.edges.forEach((edge: any) => {
      const eqs = edge.transition_condition.equations;
      const notMentionedEq = eqs.find((eq: any) => eq.operator === "==");
      if (notMentionedEq) {
        expect(notMentionedEq.right).toBe(NOT_MENTIONED);
      }
    });
  });

  it("phone_number_collected flag is added to phone confirm extract node", () => {
    const { agent } = generateAgent(baseConfig, ["phone_number", "full_name"], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const confirmPhone = flow.nodes.find((n: any) => n.name === "Confirm Phone Number");
    const flagVar = confirmPhone.variables.find((v: any) => v.name === PHONE_COLLECTED_FLAG);
    expect(flagVar).toBeDefined();
    expect(flagVar.type).toBe("boolean");
  });

  it("throws on empty data points in a path", () => {
    expect(() =>
      generateAgent(baseConfig, [], [
        { name: "Empty Path", transitionCondition: "test", dataPoints: [] },
      ], TEST_DEFAULTS),
    ).toThrow(/Path "Empty Path" has no data points/);
  });

  it("includes path name in error for bad data point reference", () => {
    expect(() =>
      generateAgent(baseConfig, [], [
        { name: "Bad Path", transitionCondition: "test", dataPoints: ["nonexistent"] as any[] },
      ], TEST_DEFAULTS),
    ).toThrow(/Path "Bad Path".*Unknown data point/);
  });

  it("generates valid agent with single data point", () => {
    const { agent, resolved } = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS);
    expect(resolved).toHaveLength(1);
    const flow = agent.conversationFlow as any;
    expect(flow.nodes.length).toBeGreaterThan(10);
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");
    expect(router.edges).toHaveLength(1);
  });
});

// ── Branch logic ────────────────────────────────────────────────────────────

describe("if/else branch support", () => {
  it("resolveDataPoints flattens a simple branch", () => {
    const raw = [
      "full_name",
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: ["phone_number"],
        elseChain: ["city"],
      },
    ];
    const resolved = resolveDataPoints(raw, TEST_DEFAULTS);
    expect(resolved).toHaveLength(3);
    expect(resolved[0].variableName).toBe("full_name");
    expect(resolved[0]._branchConditions).toBeUndefined();

    // IF branch data point
    expect(resolved[1].variableName).toBe("phone_number");
    expect(resolved[1]._branchConditions).toHaveLength(1);
    expect(resolved[1]._branchConditions![0]).toEqual({
      variable: "vehicle_type", operator: "==", value: "Semi",
    });

    // ELSE branch data point
    expect(resolved[2].variableName).toBe("city");
    expect(resolved[2]._branchConditions).toHaveLength(1);
    expect(resolved[2]._branchConditions![0]).toEqual({
      variable: "vehicle_type", operator: "!=", value: "Semi",
    });
  });

  it("resolveDataPoints flattens nested branches", () => {
    const raw = [
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: [
          {
            _branch: true as const,
            variable: "vehicle_type",
            operator: "==" as const,
            value: "Box truck", // nested condition
            ifChain: ["city"],
            elseChain: [],
          },
        ],
        elseChain: ["full_name"],
      },
    ];
    const resolved = resolveDataPoints(raw, TEST_DEFAULTS);
    expect(resolved).toHaveLength(2);

    // Nested IF: has both parent + child conditions
    expect(resolved[0].variableName).toBe("city");
    expect(resolved[0]._branchConditions).toHaveLength(2);
    expect(resolved[0]._branchConditions![0].variable).toBe("vehicle_type");
    expect(resolved[0]._branchConditions![0].operator).toBe("==");
    expect(resolved[0]._branchConditions![0].value).toBe("Semi");
    expect(resolved[0]._branchConditions![1].value).toBe("Box truck");

    // ELSE branch
    expect(resolved[1].variableName).toBe("full_name");
    expect(resolved[1]._branchConditions).toHaveLength(1);
    expect(resolved[1]._branchConditions![0].operator).toBe("!=");
  });

  it("generateAgent builds router edges with branch conditions", () => {
    const dataPoints = [
      "full_name",
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: ["phone_number"],
        elseChain: ["city"],
      },
    ];
    const { agent } = generateAgent(baseConfig, dataPoints as any[], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");

    expect(router.edges).toHaveLength(3); // full_name + phone_number (IF) + city (ELSE)

    // First edge: full_name — no branch condition, uses || operator
    const nameEdge = router.edges[0];
    expect(nameEdge.transition_condition.operator).toBe("||");

    // Second edge: phone_number (IF branch) — has branch condition, uses && operator
    const ifEdge = router.edges[1];
    expect(ifEdge.transition_condition.operator).toBe("&&");
    const ifEqs = ifEdge.transition_condition.equations;
    const branchEq = ifEqs.find((eq: any) => eq.left === "{{vehicle_type}}" && eq.operator === "==");
    expect(branchEq).toBeDefined();
    expect(branchEq.right).toBe("Semi");

    // Third edge: city (ELSE branch) — has inverted condition + sentinel guards
    const elseEdge = router.edges[2];
    expect(elseEdge.transition_condition.operator).toBe("&&");
    const elseEqs = elseEdge.transition_condition.equations;
    const invertedEq = elseEqs.find((eq: any) => eq.left === "{{vehicle_type}}" && eq.operator === "!=" && eq.right === "Semi");
    expect(invertedEq).toBeDefined();
    // Sentinel guards
    const notMentionedGuard = elseEqs.find((eq: any) => eq.left === "{{vehicle_type}}" && eq.operator === "!=" && eq.right === NOT_MENTIONED);
    expect(notMentionedGuard).toBeDefined();
    const dontKnowGuard = elseEqs.find((eq: any) => eq.left === "{{vehicle_type}}" && eq.operator === "!=" && eq.right === "Caller Doesn't Know");
    expect(dontKnowGuard).toBeDefined();
  });

  it("branch data points get Collect and Confirm nodes", () => {
    const dataPoints = [
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: ["phone_number"],
        elseChain: ["city"],
      },
    ];
    const { agent } = generateAgent(baseConfig, dataPoints as any[], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;

    // Both branch data points should have Collect + Confirm nodes
    expect(flow.nodes.find((n: any) => n.name === "Collect Phone Number")).toBeDefined();
    expect(flow.nodes.find((n: any) => n.name === "Confirm Phone Number")).toBeDefined();
    expect(flow.nodes.find((n: any) => n.name === "Collect City")).toBeDefined();
    expect(flow.nodes.find((n: any) => n.name === "Confirm City")).toBeDefined();
  });

  it("data points after a branch have no branch conditions", () => {
    const dataPoints = [
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: ["phone_number"],
        elseChain: [],
      },
      "city", // after the branch
    ];
    const resolved = resolveDataPoints(dataPoints as any[], TEST_DEFAULTS);
    const cityDp = resolved.find(dp => dp.variableName === "city");
    expect(cityDp).toBeDefined();
    expect(cityDp!._branchConditions).toBeUndefined();
  });

  it("composite data points inside branches get correct router edges", () => {
    const dataPoints = [
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: ["scheduling"],
        elseChain: [],
      },
    ];
    const { agent } = generateAgent(baseConfig, dataPoints as any[], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");
    // scheduling edge should have composite OR equations + branch AND
    const schedEdge = router.edges[0];
    expect(schedEdge.transition_condition.operator).toBe("&&");
    // Should contain equations for both preferred_day and preferred_time
    const eqs = schedEdge.transition_condition.equations;
    const dayEq = eqs.find((eq: any) => eq.left === "{{preferred_day}}");
    expect(dayEq).toBeDefined();
  });

  it("phone_number inside a branch gets both phone_collected flag and branch condition", () => {
    const dataPoints = [
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: ["phone_number"],
        elseChain: [],
      },
    ];
    const { agent } = generateAgent(baseConfig, dataPoints as any[], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");
    const phoneEdge = router.edges[0];
    // Should be AND with phone-specific equations + branch condition
    expect(phoneEdge.transition_condition.operator).toBe("&&");
    const eqs = phoneEdge.transition_condition.equations;
    // Has phone_number == Not Mentioned check
    expect(eqs.find((eq: any) => eq.left === "{{phone_number}}" && eq.operator === "==")).toBeDefined();
    // Has phone_number_collected != true check
    expect(eqs.find((eq: any) => eq.left === "{{phone_number_collected}}" && eq.operator === "!=")).toBeDefined();
    // Has branch condition
    expect(eqs.find((eq: any) => eq.left === "{{vehicle_type}}" && eq.operator === "==" && eq.right === "Semi")).toBeDefined();
  });

  it("empty branch sides produce no data points", () => {
    const raw = [
      {
        _branch: true as const,
        variable: "vehicle_type",
        operator: "==" as const,
        value: "Semi",
        ifChain: ["full_name"],
        elseChain: [], // empty ELSE
      },
    ];
    const resolved = resolveDataPoints(raw, TEST_DEFAULTS);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].variableName).toBe("full_name");
  });
});

// ── Per-path end mode (callback vs live transfer) ───────────────────────────

describe("per-path end mode", () => {
  it("default end mode is callback — variables router else_edge → Close", () => {
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "A", transitionCondition: "A", dataPoints: ["full_name"] },
        { name: "B", transitionCondition: "B", dataPoints: ["city"] },
      ],
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const closeNode = flow.nodes.find((n: any) => n.name === "Close");
    expect(closeNode).toBeDefined();
    const routerA = flow.nodes.find((n: any) => n.name === "Variables Router (A)");
    const routerB = flow.nodes.find((n: any) => n.name === "Variables Router (B)");
    expect(routerA.else_edge.destination_node_id).toBe(closeNode.id);
    expect(routerB.else_edge.destination_node_id).toBe(closeNode.id);
    expect(flow.nodes.find((n: any) => n.name?.startsWith("Pre-Transfer"))).toBeUndefined();
    expect(flow.nodes.find((n: any) => n.type === "transfer_call")).toBeUndefined();
  });

  it("end_mode=transfer wires router → Pre-Transfer → Transfer Call (number baked in)", () => {
    const dest = "+18005551234";
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "Emergency", transitionCondition: "emergency", dataPoints: ["full_name"], endMode: "transfer", transferDestination: dest },
        { name: "Quote", transitionCondition: "quote", dataPoints: ["city"] },
      ],
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;

    // Transfer-mode path: router → pre-transfer → transfer_call
    const routerEmergency = flow.nodes.find((n: any) => n.name === "Variables Router (Emergency)");
    const preTransfer = flow.nodes.find((n: any) => n.name === "Pre-Transfer (Emergency)");
    const transferCall = flow.nodes.find((n: any) => n.name === "Transfer Call (Emergency)");
    expect(preTransfer).toBeDefined();
    expect(transferCall).toBeDefined();
    expect(routerEmergency.else_edge.destination_node_id).toBe(preTransfer.id);
    expect(preTransfer.always_edge.destination_node_id).toBe(transferCall.id);
    expect(transferCall.type).toBe("transfer_call");
    expect(transferCall.transfer_destination.number).toBe(dest);

    // Callback-mode path stays on Close
    const close = flow.nodes.find((n: any) => n.name === "Close");
    const routerQuote = flow.nodes.find((n: any) => n.name === "Variables Router (Quote)");
    expect(routerQuote.else_edge.destination_node_id).toBe(close.id);

    // Shared Transfer Failed node exists once
    const transferFailed = flow.nodes.filter((n: any) => n.name === "Transfer Failed");
    expect(transferFailed).toHaveLength(1);
    expect(transferCall.edge.destination_node_id).toBe(transferFailed[0].id);
  });

  it("rejects transfer end_mode without a transferDestination", () => {
    expect(() =>
      generateAgent(
        baseConfig,
        [],
        [{ name: "Emergency", transitionCondition: "x", dataPoints: ["full_name"], endMode: "transfer" }],
        TEST_DEFAULTS,
      ),
    ).toThrow(/no dispatch call number/i);
  });

  it("does not duplicate Transfer Failed when humanRequestMode is also live_transfer", () => {
    const { agent } = generateAgent(
      { ...baseConfig, humanRequestMode: "live_transfer" } as any,
      [],
      [
        { name: "Emergency", transitionCondition: "x", dataPoints: ["full_name"], endMode: "transfer", transferDestination: "+18005551234" },
      ],
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    expect(flow.nodes.filter((n: any) => n.name === "Transfer Failed")).toHaveLength(1);
    // Both per-path (Transfer Call (Emergency)) and the global Transfer Call should exist
    expect(flow.nodes.filter((n: any) => n.type === "transfer_call").length).toBe(2);
  });
});
