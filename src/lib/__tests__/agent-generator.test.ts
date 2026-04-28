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
