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
import {
  buildPreTransferNode,
  buildPerPathTransferCallNode,
  buildDataChain,
  makeIdFactory,
} from "../agent-generator/node-builders.js";

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

  it("preserves optional label on composite sub-variables", () => {
    const customDefaults = {
      ...TEST_DEFAULTS,
      scheduling: {
        ...TEST_DEFAULTS.scheduling,
        variables: [
          { variableName: "preferred_day", type: "string" as const, description: "Day", label: "Day" },
          { variableName: "preferred_time", type: "string" as const, description: "Time", label: "Time Window" },
        ],
      },
    } as any;
    const resolved = resolveDataPoints(["scheduling"], customDefaults);
    expect(resolved[0].variables![0].label).toBe("Day");
    expect(resolved[0].variables![1].label).toBe("Time Window");
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

  describe("workspace-default fallback for object-form data points", () => {
    it("inherits workspace-default finetuneExamples when per-agent override is undefined", () => {
      const resolved = resolveDataPoints(
        [{ variableName: "full_name" }],
        TEST_DEFAULTS,
      );
      expect(resolved[0].finetuneExamples).toEqual(
        TEST_DEFAULTS.full_name.finetuneExamples,
      );
    });

    it("inherits workspace-default conversationPrompt when per-agent override is undefined", () => {
      const resolved = resolveDataPoints(
        [{ variableName: "full_name" }],
        TEST_DEFAULTS,
      );
      expect(resolved[0].conversationPrompt).toBe(
        TEST_DEFAULTS.full_name.conversationPrompt,
      );
    });

    it("inherits workspace-default forwardCondition when per-agent override is undefined", () => {
      const resolved = resolveDataPoints(
        [{ variableName: "full_name" }],
        TEST_DEFAULTS,
      );
      expect(resolved[0].forwardCondition).toBe(
        TEST_DEFAULTS.full_name.forwardCondition,
      );
    });

    it("per-agent override wins over workspace default", () => {
      const customExamples = [
        { type: "positive" as const, transcript: [{ content: "Sam", role: "user" as const }] },
      ];
      const resolved = resolveDataPoints(
        [{
          variableName: "full_name",
          conversationPrompt: "custom prompt",
          forwardCondition: "custom condition",
          finetuneExamples: customExamples,
        }],
        TEST_DEFAULTS,
      );
      expect(resolved[0].conversationPrompt).toBe("custom prompt");
      expect(resolved[0].forwardCondition).toBe("custom condition");
      expect(resolved[0].finetuneExamples).toEqual(customExamples);
    });

    it("respects explicit empty finetuneExamples (operator cleared them)", () => {
      const resolved = resolveDataPoints(
        [{ variableName: "full_name", finetuneExamples: [] }],
        TEST_DEFAULTS,
      );
      expect(resolved[0].finetuneExamples).toEqual([]);
    });

    it("falls through to algorithmic boilerplate when variableName not in registry", () => {
      const resolved = resolveDataPoints(
        [{ variableName: "totally_custom" }],
        TEST_DEFAULTS,
      );
      expect(resolved[0].conversationPrompt).toMatch(/Ask the caller for their totally custom/);
      expect(resolved[0].forwardCondition).toMatch(/totally custom/);
      expect(resolved[0].finetuneExamples).toEqual([]);
    });
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
    // resolvedPaths[i].resolved is a union (DataPoint | SendSmsAction); this
    // test only uses DPs, so cast for property access.
    expect((resolvedPaths![0].resolved[0] as any).variableName).toBe("full_name");
    expect((resolvedPaths![1].resolved[0] as any).variableName).toBe("city");
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

  it("allows empty data points in a callback path (transition skips to Close)", () => {
    const { agent } = generateAgent(baseConfig, [], [
      { name: "Empty Path", transitionCondition: "test", dataPoints: [] },
    ], TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const close = flow.nodes.find((n: any) => n.name === "Close");
    const transition = flow.nodes.find((n: any) => n.name === "Conversation");
    expect(close).toBeDefined();
    expect(transition).toBeDefined();
    expect(transition.skip_response_edge.destination_node_id).toBe(close.id);
    // No Extract / Variables Router nodes generated for this path
    const extracts = flow.nodes.filter((n: any) => n.type === "extract_dynamic_variables");
    expect(extracts).toHaveLength(0);
  });

  it("allows empty data points in a transfer path (transition skips to Pre-Transfer)", () => {
    const { agent } = generateAgent(baseConfig, [], [
      {
        name: "Immediate Transfer",
        transitionCondition: "caller wants live person",
        dataPoints: [],
        endMode: "transfer",
        transferDestination: "+18005551234",
      },
    ], TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    // Transition node points at the per-path Pre-Transfer node
    const transition = flow.nodes.find((n: any) => n.type === "conversation" && n.skip_response_edge);
    const preTransfer = flow.nodes.find((n: any) =>
      n.type === "conversation" && /Pre-?Transfer|Hold on a moment/.test(JSON.stringify(n.instruction || "")));
    expect(preTransfer).toBeDefined();
    expect(transition.skip_response_edge.destination_node_id).toBe(preTransfer.id);
    // Per-path transfer call node still generated
    const perPathTransfer = flow.nodes.find((n: any) => n.type === "transfer_call");
    expect(perPathTransfer).toBeDefined();
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
  it("default end mode is callback — each path's router else_edge → its own Close (A/B)", () => {
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
    const closeA = flow.nodes.find((n: any) => n.name === "Close (A)");
    const closeB = flow.nodes.find((n: any) => n.name === "Close (B)");
    expect(closeA).toBeDefined();
    expect(closeB).toBeDefined();
    expect(closeA.id).not.toBe(closeB.id);
    const routerA = flow.nodes.find((n: any) => n.name === "Variables Router (A)");
    const routerB = flow.nodes.find((n: any) => n.name === "Variables Router (B)");
    expect(routerA.else_edge.destination_node_id).toBe(closeA.id);
    expect(routerB.else_edge.destination_node_id).toBe(closeB.id);
    // Both per-path Close nodes share the Close Question node, which in turn
    // routes to Closing Remarks via its "no more questions" edge.
    const closeQuestion = flow.nodes.find((n: any) => n.name === "Close Question");
    const closingRemarks = flow.nodes.find((n: any) => n.name === "Closing Remarks");
    expect(closeQuestion).toBeDefined();
    expect(closeA.always_edge.destination_node_id).toBe(closeQuestion.id);
    expect(closeB.always_edge.destination_node_id).toBe(closeQuestion.id);
    expect(closeQuestion.edges[0].destination_node_id).toBe(closingRemarks.id);
    // No legacy unsuffixed "Close" node in multi-path agents
    expect(flow.nodes.find((n: any) => n.name === "Close")).toBeUndefined();
    expect(flow.nodes.find((n: any) => n.name?.startsWith("Pre-Transfer"))).toBeUndefined();
    expect(flow.nodes.find((n: any) => n.type === "transfer_call")).toBeUndefined();
  });

  it("single-path agents wire Close → Close Question → Closing Remarks → Closing Statement", () => {
    const { agent } = generateAgent(
      baseConfig,
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const close = flow.nodes.find((n: any) => n.name === "Close");
    const closeQuestion = flow.nodes.find((n: any) => n.name === "Close Question");
    const closingRemarks = flow.nodes.find((n: any) => n.name === "Closing Remarks");
    const closingStatement = flow.nodes.find((n: any) => n.name === "Closing Statement");

    expect(close).toBeDefined();
    expect(closeQuestion).toBeDefined();
    expect(closingRemarks).toBeDefined();
    expect(closingStatement).toBeDefined();

    // Chain: Close → Close Question → Closing Remarks → Closing Statement.
    expect(close.always_edge.destination_node_id).toBe(closeQuestion.id);
    // Close Question has ONE explicit edge: "no more questions" → Closing
    // Remarks. The follow-up-question path runs through the Admin/FAQ
    // global node's `condition`; we used to emit a second explicit edge
    // here for context-specific training but Retell's console rendered
    // that as a duplicate Admin/FAQ entry (once via edge, once via global)
    // so it was dropped. The finetune_transition_examples below still
    // train the global jump with their destination_node_id.
    expect(closeQuestion.edges).toHaveLength(1);
    const noMoreEdge = closeQuestion.edges[0];
    expect(noMoreEdge.transition_condition.prompt).toBe("The caller has no more questions");
    expect(noMoreEdge.destination_node_id).toBe(closingRemarks.id);
    expect(closingRemarks.always_edge.destination_node_id).toBe(closingStatement.id);

    // Default prompt text is used when no override is provided.
    expect(closeQuestion.instruction.text).toContain("anything else");

    // Finetune transition examples train the FAQ jump from this node by
    // pointing at the global FAQ node id (no explicit edge needed).
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    expect(closeQuestion.finetune_transition_examples.length).toBeGreaterThan(0);
    for (const ex of closeQuestion.finetune_transition_examples) {
      expect(ex.destination_node_id).toBe(faq.id);
      expect(ex.transcript.length).toBeGreaterThan(0);
    }
  });

  it("Close Question has NO explicit edge to Admin/FAQ (regression — Retell UI duplicate)", () => {
    // Regression for the bug where the Close Question node had two edges
    // (Closing Remarks + Admin/FAQ). Retell's console rendered the FAQ
    // edge plus the global FAQ jump as duplicate Admin/FAQ entries in
    // the destination picker. Drop the explicit edge — keep the FT
    // examples pointing at the global FAQ id so the training still
    // triggers the global jump.
    const { agent } = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const closeQuestion = flow.nodes.find((n: any) => n.name === "Close Question");
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    expect(closeQuestion).toBeDefined();
    expect(faq).toBeDefined();

    // No edge from Close Question to Admin/FAQ.
    const faqEdges = (closeQuestion.edges as any[]).filter(
      (e) => e.destination_node_id === faq.id,
    );
    expect(faqEdges).toHaveLength(0);

    // No edge with the legacy "has another question" prompt either.
    const anotherQuestionEdges = (closeQuestion.edges as any[]).filter(
      (e) => e.transition_condition?.prompt === "The caller has another question",
    );
    expect(anotherQuestionEdges).toHaveLength(0);

    // And: FT examples still train the FAQ jump.
    expect(closeQuestion.finetune_transition_examples.length).toBeGreaterThan(0);
    expect(
      closeQuestion.finetune_transition_examples.every(
        (ex: any) => ex.destination_node_id === faq.id,
      ),
    ).toBe(true);
  });

  it("Close Question shape holds in multi-path agents too", () => {
    // The multi-path generator shares a single Close Question node across
    // per-path Close nodes (already asserted above). This test pins the
    // shape: 1 edge, FT examples → global FAQ, no FAQ edge.
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "A", transitionCondition: "is A", dataPoints: ["full_name"] },
        { name: "B", transitionCondition: "is B", dataPoints: ["phone_number"] },
      ],
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const closeQuestion = flow.nodes.find((n: any) => n.name === "Close Question");
    const closingRemarks = flow.nodes.find((n: any) => n.name === "Closing Remarks");
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    expect(closeQuestion).toBeDefined();

    expect(closeQuestion.edges).toHaveLength(1);
    expect(closeQuestion.edges[0].destination_node_id).toBe(closingRemarks.id);
    expect(closeQuestion.edges[0].transition_condition.prompt).toBe(
      "The caller has no more questions",
    );

    expect(closeQuestion.finetune_transition_examples.length).toBeGreaterThan(0);
    for (const ex of closeQuestion.finetune_transition_examples) {
      expect(ex.destination_node_id).toBe(faq.id);
    }
  });

  it("closeQuestionPrompt override propagates to the rendered Close Question node", () => {
    const customPrompt = "Custom: any other concerns I can address before I let you go?";
    const { agent } = generateAgent(
      { ...baseConfig, closeQuestionPrompt: customPrompt },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const closeQuestion = flow.nodes.find((n: any) => n.name === "Close Question");
    expect(closeQuestion).toBeDefined();
    expect(closeQuestion.instruction.text).toBe(customPrompt);
  });

  it("closeQuestionFinetuneExamples workspace override extends the hardcoded baseline (additive)", () => {
    const custom = [
      {
        type: "positive" as const,
        transcript: [
          { content: "Oh yeah — what's your weekend availability look like?", role: "user" as const },
          { content: "", role: "agent" as const },
        ],
      },
    ];
    const { agent } = generateAgent(
      { ...baseConfig, closeQuestionFinetuneExamples: custom },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const closeQuestion = flow.nodes.find((n: any) => n.name === "Close Question");
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    const fts = closeQuestion.finetune_transition_examples as any[];

    // Baseline (8) + 1 workspace addition = 9 total. Override doesn't
    // replace the baseline.
    expect(fts).toHaveLength(9);
    // Every entry targets the global FAQ node id.
    for (const ex of fts) expect(ex.destination_node_id).toBe(faq.id);
    // The workspace addition is present at the end.
    expect(fts[fts.length - 1].transcript[0].content).toBe(
      "Oh yeah — what's your weekend availability look like?",
    );
  });

  it("faqGlobalFinetuneExamples workspace override extends the hardcoded baseline (additive)", () => {
    const custom = [
      {
        type: "positive" as const,
        transcript: [
          { content: "What are your business hours during the holidays?", role: "user" as const },
          { content: "", role: "agent" as const },
        ],
      },
      {
        type: "positive" as const,
        transcript: [
          { content: "Do you accept credit cards?", role: "user" as const },
          { content: "", role: "agent" as const },
        ],
      },
    ];
    const { agent } = generateAgent(
      { ...baseConfig, faqGlobalFinetuneExamples: custom },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    const positives = faq.global_node_setting.positive_finetune_examples as any[];

    // Baseline must still ship — verify by length grew from 2 (workspace
    // alone) and at least one well-known baseline phrasing is present.
    expect(positives.length).toBeGreaterThan(2);
    const utterances = positives.map(
      (ex: any) => ex.transcript.find((t: any) => t.role === "user")?.content,
    );
    expect(utterances).toContain("What are your business hours during the holidays?");
    expect(utterances).toContain("Do you accept credit cards?");
    // And a well-known baseline phrasing.
    expect(utterances).toContain("How much is a service call?");
  });

  it("Intro carries default FAQ-jump FT examples targeting the global FAQ", () => {
    // Baseline (no workspace override): the hardcoded
    // INTRO_FAQ_FINETUNE_EXAMPLES bake in. They live on the Intro node
    // with destination_node_id = FAQ node id and NO explicit edge to
    // FAQ — single source of truth in the Retell UI (same UI-clean
    // pattern as Close Question).
    const { agent } = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const intro = flow.nodes.find((n: any) => n.name === "Intro");
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    expect(intro).toBeDefined();
    expect(faq).toBeDefined();

    // No explicit edge from Intro to FAQ.
    const faqEdges = (intro.edges as any[]).filter(
      (e) => e.destination_node_id === faq.id,
    );
    expect(faqEdges).toHaveLength(0);

    // FT examples include at least one targeting the global FAQ.
    const faqFts = (intro.finetune_transition_examples as any[]).filter(
      (ex) => ex.destination_node_id === faq.id,
    );
    expect(faqFts.length).toBeGreaterThan(0);
    for (const ex of faqFts) {
      expect(Array.isArray(ex.transcript) && ex.transcript.length > 0).toBe(true);
    }
  });

  it("introFaqFinetuneExamples workspace override extends the hardcoded baseline (additive)", () => {
    const custom = [
      {
        type: "positive" as const,
        transcript: [
          { content: "Hey, do you guys do free quotes?", role: "user" as const },
          { content: "", role: "agent" as const },
        ],
      },
    ];
    const { agent } = generateAgent(
      { ...baseConfig, introFaqFinetuneExamples: custom },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const intro = flow.nodes.find((n: any) => n.name === "Intro");
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");

    const faqFts = (intro.finetune_transition_examples as any[]).filter(
      (ex) => ex.destination_node_id === faq.id,
    );
    // Baseline (8) + 1 workspace addition = 9 total.
    expect(faqFts.length).toBeGreaterThan(1);
    const utterances = faqFts.map(
      (ex: any) => ex.transcript.find((t: any) => t.role === "user")?.content,
    );
    expect(utterances).toContain("Hey, do you guys do free quotes?");
  });

  it("Emergency Guardrail node is no longer emitted (removed in favor of Retell's built-in)", () => {
    const { agent } = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const emergency = flow.nodes.find((n: any) => n.name === "Emergency Gaurd Rail");
    expect(emergency).toBeUndefined();
  });

  it("Human Request baseline ships ≥10 examples and operator override layers additively", () => {
    // Sanity: baseline alone.
    const noOverride = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS).agent
      .conversationFlow as any;
    const hrBaseline = noOverride.nodes.find((n: any) => n.name === "Human Request")
      .global_node_setting.positive_finetune_examples as any[];
    expect(hrBaseline.length).toBeGreaterThanOrEqual(10);

    // Operator extends baseline; baseline still present.
    const customExample = {
      type: "positive" as const,
      transcript: [
        { content: "I need a real human, not your AI.", role: "user" as const },
        { content: "", role: "agent" as const },
      ],
    };
    const withOverride = generateAgent(
      { ...baseConfig, humanRequestFinetuneExamples: [customExample] },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    ).agent.conversationFlow as any;
    const hrWith = withOverride.nodes.find((n: any) => n.name === "Human Request")
      .global_node_setting.positive_finetune_examples as any[];

    expect(hrWith.length).toBe(hrBaseline.length + 1);
    const utterances = hrWith.map(
      (ex: any) => ex.transcript.find((t: any) => t.role === "user")?.content,
    );
    expect(utterances).toContain("I need a real human, not your AI.");
    // Sanity: a known baseline phrasing survives the merge.
    expect(utterances).toContain("can I talk to the supervisor?");
  });

  it("Irrelevant Guardrail baseline ships ≥6 positive examples and operator override layers additively", () => {
    const noOverride = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS).agent
      .conversationFlow as any;
    const igBaseline = noOverride.nodes.find((n: any) => n.name === "irrelevantGaurdrail")
      .global_node_setting.positive_finetune_examples as any[];
    expect(igBaseline.length).toBeGreaterThanOrEqual(6);

    const customExample = {
      type: "positive" as const,
      transcript: [
        { content: "What's your favorite TV show?", role: "user" as const },
        { content: "", role: "agent" as const },
      ],
    };
    const withOverride = generateAgent(
      { ...baseConfig, irrelevantGuardrailFinetuneExamples: [customExample] },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    ).agent.conversationFlow as any;
    const igWith = withOverride.nodes.find((n: any) => n.name === "irrelevantGaurdrail")
      .global_node_setting.positive_finetune_examples as any[];

    expect(igWith.length).toBe(igBaseline.length + 1);
    const utterances = igWith.map(
      (ex: any) => ex.transcript.find((t: any) => t.role === "user")?.content,
    );
    expect(utterances).toContain("What's your favorite TV show?");
    // Sanity: a known baseline phrasing.
    expect(utterances).toContain("Tell me a joke.");
  });

  it("Workspace override dedups by user-utterance (no doubled entries)", () => {
    // Operator pastes a phrasing that already exists in the FAQ baseline.
    // The merge should NOT double it.
    const dup = {
      type: "positive" as const,
      transcript: [
        // Matches an existing FAQ_GLOBAL_POSITIVE_EXAMPLES entry.
        { content: "How much is a service call?", role: "user" as const },
        { content: "", role: "agent" as const },
      ],
    };
    const { agent } = generateAgent(
      { ...baseConfig, faqGlobalFinetuneExamples: [dup] },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const positives = flow.nodes.find((n: any) => n.name === "Admin/FAQ")
      .global_node_setting.positive_finetune_examples as any[];
    const occurrences = positives.filter(
      (ex: any) =>
        ex.transcript.find((t: any) => t.role === "user")?.content === "How much is a service call?",
    );
    expect(occurrences).toHaveLength(1);
  });

  it("canvas layout — globals left, paths staircase, closing chain bottom row", () => {
    // Regression coverage for the canvas-layout cleanup. Snapshots drop
    // display_position so we need explicit assertions to lock in the
    // shape. Three invariants:
    //   1. Globals (Admin/FAQ, Human Request, irrelevant + emergency
    //      guardrails, Polite Hangup, guardrail End) sit at NEGATIVE x.
    //   2. Each path's Transition / Extract / Router share a Y row, and
    //      Collect/Confirm pairs march downward at uniform spacing.
    //   3. Per-path Close nodes stack vertically; Close Question +
    //      Closing Remarks + Closing Statement + End share one Y row.
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "A", transitionCondition: "x", dataPoints: ["full_name", "phone_number"] },
        { name: "B", transitionCondition: "y", dataPoints: ["full_name", "city"] },
      ],
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const byName = (n: string) => flow.nodes.find((node: any) => node.name === n);

    // 1. Globals on the left.
    for (const name of ["Admin/FAQ", "Human Request", "irrelevantGaurdrail", "Polite Hangup"]) {
      const node = byName(name);
      expect(node, `${name} should exist`).toBeDefined();
      expect(node.display_position.x, `${name} should be at negative x`).toBeLessThan(0);
    }

    // 2. Path A — header row aligned, DP pairs march downward.
    const transitionA = byName("Transition (A)");
    const extractA = byName("Extract All Variables (A)");
    const routerA = byName("Variables Router (A)");
    expect(transitionA.display_position.y).toBe(extractA.display_position.y);
    expect(extractA.display_position.y).toBe(routerA.display_position.y);
    expect(transitionA.display_position.x).toBeLessThan(extractA.display_position.x);
    expect(extractA.display_position.x).toBeLessThan(routerA.display_position.x);

    // Each Collect/Confirm pair shares Y; pair N+1 is below pair N.
    const collectNodesA = flow.nodes.filter((n: any) =>
      n.type === "conversation" && /Collect /.test(n.name) &&
      // Per-path collect nodes don't have a name suffix; identify Path A's
      // ones via the router edges that point at them.
      (routerA.edges as any[]).some((e: any) => e.destination_node_id === n.id),
    );
    expect(collectNodesA.length).toBe(2);
    const sortedA = [...collectNodesA].sort((a: any, b: any) => a.display_position.y - b.display_position.y);
    expect(sortedA[0].display_position.y).toBeLessThan(sortedA[1].display_position.y);

    // 3. Closing chain on one row, per-path closes stacked.
    const closeA = byName("Close (A)");
    const closeB = byName("Close (B)");
    const closeQuestion = byName("Close Question");
    const closingRemarks = byName("Closing Remarks");
    const closingStatement = byName("Closing Statement");
    // Per-path closes: same X, different Y.
    expect(closeA.display_position.x).toBe(closeB.display_position.x);
    expect(closeA.display_position.y).not.toBe(closeB.display_position.y);
    // Closing Remarks + Closing Statement on one row (same Y as Close Question).
    expect(closingRemarks.display_position.y).toBe(closeQuestion.display_position.y);
    expect(closingStatement.display_position.y).toBe(closeQuestion.display_position.y);
    // And the row marches left-to-right: close column < closeQuestion < closingRemarks < closingStatement.
    expect(closeA.display_position.x).toBeLessThan(closeQuestion.display_position.x);
    expect(closeQuestion.display_position.x).toBeLessThan(closingRemarks.display_position.x);
    expect(closingRemarks.display_position.x).toBeLessThan(closingStatement.display_position.x);
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

    // Callback-mode path stays on its own per-path Close (multi-path agent)
    const close = flow.nodes.find((n: any) => n.name === "Close (Quote)");
    const routerQuote = flow.nodes.find((n: any) => n.name === "Variables Router (Quote)");
    expect(routerQuote.else_edge.destination_node_id).toBe(close.id);
    // Transfer paths don't have a Close node
    expect(flow.nodes.find((n: any) => n.name === "Close (Emergency)")).toBeUndefined();

    // Shared Live Transfer Recovery node exists once
    const recovery = flow.nodes.filter((n: any) => n.name === "Live Transfer Recovery");
    expect(recovery).toHaveLength(1);
    expect(transferCall.edge.destination_node_id).toBe(recovery[0].id);

    // transfer_option must use the agentic_warm_transfer shape with the shared
    // warm-transfer screener agent (not the legacy cold_transfer defaults).
    expect(transferCall.transfer_option.type).toBe("agentic_warm_transfer");
    expect(transferCall.transfer_option.agentic_transfer_config.transfer_agent.agent_id).toBe(
      "agent_1d0e26bb0cbe39bc9ea3214984",
    );
    expect(transferCall.transfer_option.agentic_transfer_config.transfer_agent.agent_version).toBe(5);
    expect(transferCall.transfer_option.agentic_transfer_config.transfer_timeout_ms).toBe(30000);
    expect(transferCall.transfer_option.agentic_transfer_config.action_on_timeout).toBe("cancel_transfer");
    expect(transferCall.transfer_option.enable_bridge_audio_cue).toBe(false);
    expect(transferCall.transfer_option.agent_detection_timeout_ms).toBe(10000);
    expect(transferCall.transfer_option.on_hold_music).toBe("relaxing_sound");
    expect(transferCall.transfer_option.show_transferee_as_caller).toBe(false);
  });

  it("uses warmTransferAgentVersion from agent config when provided", () => {
    const { agent } = generateAgent(
      { ...baseConfig, warmTransferAgentVersion: 17 } as any,
      [],
      [
        { name: "Emergency", transitionCondition: "x", dataPoints: ["full_name"], endMode: "transfer", transferDestination: "+18005551234" },
        { name: "Quote", transitionCondition: "y", dataPoints: ["city"] },
      ],
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const transferCall = flow.nodes.find((n: any) => n.type === "transfer_call");
    expect(transferCall.transfer_option.agentic_transfer_config.transfer_agent.agent_version).toBe(17);
  });

  it("global Transfer Call (live_transfer human-request mode) also uses agentic_warm_transfer", () => {
    const { agent } = generateAgent(
      { ...baseConfig, humanRequestMode: "live_transfer" } as any,
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    const transferCall = flow.nodes.find((n: any) => n.name === "Transfer Call");
    expect(transferCall.type).toBe("transfer_call");
    expect(transferCall.transfer_destination.number).toBe("{{dispatch_number}}");
    expect(transferCall.transfer_option.type).toBe("agentic_warm_transfer");
    expect(transferCall.transfer_option.agentic_transfer_config.transfer_agent.agent_id).toBe(
      "agent_1d0e26bb0cbe39bc9ea3214984",
    );
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

  it("does not duplicate Live Transfer Recovery when humanRequestMode is also live_transfer", () => {
    const { agent } = generateAgent(
      { ...baseConfig, humanRequestMode: "live_transfer" } as any,
      [],
      [
        { name: "Emergency", transitionCondition: "x", dataPoints: ["full_name"], endMode: "transfer", transferDestination: "+18005551234" },
      ],
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    expect(flow.nodes.filter((n: any) => n.name === "Live Transfer Recovery")).toHaveLength(1);
    // Both per-path (Transfer Call (Emergency)) and the global Transfer Call should exist
    expect(flow.nodes.filter((n: any) => n.type === "transfer_call").length).toBe(2);
  });
});

// ── node-builders defensive guards ──────────────────────────────────────────
// These throws fire when the IDs / positions allocator drifts out of sync with
// the path config. They're internal-invariant guards; if they ever fire in
// production we have a bigger bug. Cover them so the assertion stays honest.

describe("node-builders defensive guards", () => {
  const f = makeIdFactory(1);

  it("buildPreTransferNode throws when preTransferId is missing", () => {
    expect(() =>
      buildPreTransferNode(
        { transferCallId: "tc1", chain: [] } as any,
        { preTransfer: { x: 0, y: 0 } } as any,
        baseConfig as any,
        "Path",
        f,
      ),
    ).toThrow(/missing transfer slots/);
  });

  it("buildPreTransferNode throws when transferCallId is missing", () => {
    expect(() =>
      buildPreTransferNode(
        { preTransferId: "pt1", chain: [] } as any,
        { preTransfer: { x: 0, y: 0 } } as any,
        baseConfig as any,
        "Path",
        f,
      ),
    ).toThrow(/missing transfer slots/);
  });

  it("buildPreTransferNode throws when preTransfer position is missing", () => {
    expect(() =>
      buildPreTransferNode(
        { preTransferId: "pt1", transferCallId: "tc1", chain: [] } as any,
        {} as any,
        baseConfig as any,
        "Path",
        f,
      ),
    ).toThrow(/missing transfer slots/);
  });

  it("buildPerPathTransferCallNode throws when transferCallId is missing", () => {
    expect(() =>
      buildPerPathTransferCallNode(
        { chain: [] } as any,
        { transferCall: { x: 0, y: 0 } } as any,
        { transferFailedId: "tf1" } as any,
        "+15551234567",
        "Path",
        f,
      ),
    ).toThrow(/missing transfer slots/);
  });

  it("buildPerPathTransferCallNode throws when transferCall position is missing", () => {
    expect(() =>
      buildPerPathTransferCallNode(
        { transferCallId: "tc1", chain: [] } as any,
        {} as any,
        { transferFailedId: "tf1" } as any,
        "+15551234567",
        "Path",
        f,
      ),
    ).toThrow(/missing transfer slots/);
  });

  it("buildDataChain throws when resolvedDataPoints count diverges from chain IDs", () => {
    expect(() =>
      buildDataChain(
        [{ variableName: "x" } as any, { variableName: "y" } as any], // 2 data points
        { chain: [{ collectId: "c1", confirmId: "cf1" }] } as any, // only 1 chain slot
        {} as any, // pathPos
        "close_id", // closeId
        f, // IdFactory
      ),
    ).toThrow(/does not match allocated chain IDs/);
  });
});

describe("Human Request global fine-tunes", () => {
  function findHumanRequest(agent: any) {
    return agent.conversationFlow.nodes.find((n: any) => n.name === "Human Request");
  }
  function utterancesOf(node: any): string[] {
    const ex = node?.global_node_setting?.positive_finetune_examples ?? [];
    return ex.map((e: any) =>
      e.transcript?.find((t: any) => t.role === "user")?.content?.trim() ?? "",
    );
  }

  it("includes the hardcoded baseline when no operator examples are supplied", () => {
    const { agent } = generateAgent(baseConfig, ["full_name"], undefined, TEST_DEFAULTS);
    const utterances = utterancesOf(findHumanRequest(agent));
    // Baseline has ≥10 phrasings (was 1 before the May-2026 expansion).
    expect(utterances.length).toBeGreaterThanOrEqual(10);
    expect(utterances).toContain("can I talk to the supervisor?");
    expect(utterances).toContain("Transfer me to a human.");
  });

  it("merges operator-supplied examples on top of the baseline", () => {
    const { agent } = generateAgent(
      {
        ...baseConfig,
        humanRequestFinetuneExamples: [
          { type: "positive", transcript: [{ role: "user", content: "Put me through to a person." }, { role: "agent", content: "" }] },
          { type: "positive", transcript: [{ role: "user", content: "Can you transfer me to your manager?" }, { role: "agent", content: "" }] },
        ],
      },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const utterances = utterancesOf(findHumanRequest(agent));
    // Operator additions appended; baseline survives.
    expect(utterances).toContain("can I talk to the supervisor?");
    expect(utterances).toContain("Put me through to a person.");
    expect(utterances).toContain("Can you transfer me to your manager?");
  });

  it("dedups operator examples that duplicate the baseline utterance", () => {
    // Hardening: re-publishes shouldn't accumulate duplicates when the
    // operator's own list happens to include the same supervisor utterance.
    const { agent } = generateAgent(
      {
        ...baseConfig,
        humanRequestFinetuneExamples: [
          { type: "positive", transcript: [{ role: "user", content: "can I talk to the supervisor?" }, { role: "agent", content: "" }] },
          { type: "positive", transcript: [{ role: "user", content: "Talk to a human please." }, { role: "agent", content: "" }] },
        ],
      },
      ["full_name"],
      undefined,
      TEST_DEFAULTS,
    );
    const utterances = utterancesOf(findHumanRequest(agent));
    // Supervisor phrasing appears exactly once (baseline + operator dup → 1).
    const supervisorCount = utterances.filter((u) => u === "can I talk to the supervisor?").length;
    expect(supervisorCount).toBe(1);
    expect(utterances).toContain("Talk to a human please.");
  });

  it("populates callback mode the same way as live_transfer mode", () => {
    const operatorExamples = [
      { type: "positive" as const, transcript: [{ role: "user" as const, content: "transfer me" }, { role: "agent" as const, content: "" }] },
    ];
    const { agent: callback } = generateAgent(
      { ...baseConfig, humanRequestFinetuneExamples: operatorExamples },
      ["full_name"], undefined, TEST_DEFAULTS,
    );
    const { agent: transfer } = generateAgent(
      { ...baseConfig, humanRequestFinetuneExamples: operatorExamples, humanRequestMode: "live_transfer" as const },
      ["full_name"], undefined, TEST_DEFAULTS,
    );
    expect(utterancesOf(findHumanRequest(callback))).toEqual(
      utterancesOf(findHumanRequest(transfer)),
    );
    // Both should contain the baseline + operator addition.
    expect(utterancesOf(findHumanRequest(callback))).toContain("transfer me");
    expect(utterancesOf(findHumanRequest(callback))).toContain("can I talk to the supervisor?");
  });
});
