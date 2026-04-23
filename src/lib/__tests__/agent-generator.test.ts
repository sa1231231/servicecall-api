import { describe, it, expect } from "vitest";
import {
  generateAgent,
  resolveDataPoints,
  DATA_POINT_REGISTRY,
  type DataPoint,
} from "../agent-generator/index.js";

const baseConfig = {
  businessName: "Test Co",
  faqKnowledgeBase: "FAQ content here",
  introFinetuneExamples: [],
};

// ── resolveDataPoints ────────────────────────────────────────────────────────

describe("resolveDataPoints", () => {
  it("resolves built-in string references", () => {
    const resolved = resolveDataPoints(["full_name", "phone_number"]);
    expect(resolved).toHaveLength(2);
    expect(resolved[0].variableName).toBe("full_name");
    expect(resolved[0].label).toBe("Full Name");
    expect(resolved[1].variableName).toBe("phone_number");
  });

  it("throws on unknown built-in reference", () => {
    expect(() => resolveDataPoints(["nonexistent"])).toThrow(
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
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].variableName).toBe("custom_field");
    expect(resolved[0].label).toBe("My Field");
  });

  it("fills defaults for partial custom objects", () => {
    const resolved = resolveDataPoints([{ variableName: "my_var" }]);
    expect(resolved[0].label).toBe("My Var");
    expect(resolved[0].type).toBe("string");
    expect(resolved[0].conversationPrompt).toContain("my var");
    expect(resolved[0].extractSuccessEquation).toHaveLength(2);
  });

  it("throws when custom object missing variableName", () => {
    expect(() => resolveDataPoints([{ label: "No Name" } as any])).toThrow(
      /missing required field: variableName/,
    );
  });

  it("resolves composite data points", () => {
    const resolved = resolveDataPoints(["scheduling"]);
    expect(resolved[0].composite).toBe(true);
    expect(resolved[0].variables).toHaveLength(2);
    expect(resolved[0].variables![0].variableName).toBe("preferred_day");
    expect(resolved[0].variables![1].variableName).toBe("preferred_time");
  });

  it("resolves all trucking built-ins", () => {
    const truckingKeys = [
      "truck_number", "driver_name", "driver_phone", "breakdown_location",
      "problem_description", "vehicle_type", "vehicle_manufacturer",
      "vehicle_color", "whos_paying", "payment_method",
    ];
    const resolved = resolveDataPoints(truckingKeys);
    expect(resolved).toHaveLength(10);
    resolved.forEach((dp, i) => {
      expect(dp.variableName).toBe(truckingKeys[i]);
    });
  });
});

// ── DATA_POINT_REGISTRY ──────────────────────────────────────────────────────

describe("DATA_POINT_REGISTRY", () => {
  it("has all expected general entries", () => {
    const generalKeys = ["full_name", "phone_number", "email", "street_address", "city", "company_name", "scheduling"];
    generalKeys.forEach(key => {
      expect(DATA_POINT_REGISTRY[key]).toBeDefined();
    });
  });

  it("has all expected trucking entries", () => {
    const truckingKeys = [
      "truck_number", "driver_name", "driver_phone", "breakdown_location",
      "problem_description", "vehicle_type", "vehicle_manufacturer",
      "vehicle_color", "whos_paying", "payment_method",
    ];
    truckingKeys.forEach(key => {
      expect(DATA_POINT_REGISTRY[key]).toBeDefined();
      expect(DATA_POINT_REGISTRY[key].variableName).toBe(key);
    });
  });

  it("enum data points have choices array with 'Not Mentioned'", () => {
    const enumKeys = ["vehicle_type", "vehicle_manufacturer", "vehicle_color", "payment_method"];
    enumKeys.forEach(key => {
      const dp = DATA_POINT_REGISTRY[key];
      expect(dp.type).toBe("enum");
      expect(dp.choices).toContain("Not Mentioned");
      expect(dp.choices!.length).toBeGreaterThan(2);
    });
  });

  it("all entries have required fields", () => {
    Object.entries(DATA_POINT_REGISTRY).forEach(([key, dp]) => {
      expect(dp.label, `${key}.label`).toBeTruthy();
      expect(dp.variableName, `${key}.variableName`).toBe(key);
      expect(dp.conversationPrompt, `${key}.conversationPrompt`).toBeTruthy();
      expect(dp.forwardCondition, `${key}.forwardCondition`).toBeTruthy();
    });
  });

  it("all data points include 'don't know' in forwardCondition", () => {
    Object.entries(DATA_POINT_REGISTRY).forEach(([key, dp]) => {
      expect(dp.forwardCondition, `${key}.forwardCondition`).toMatch(/don't know/i);
    });
  });

  it("all data points include 'don't know' in conversationPrompt", () => {
    Object.entries(DATA_POINT_REGISTRY).forEach(([key, dp]) => {
      expect(dp.conversationPrompt, `${key}.conversationPrompt`).toMatch(/don't know/i);
    });
  });

  it("all non-composite data points include 'Caller Doesn\\'t Know' in description", () => {
    Object.entries(DATA_POINT_REGISTRY).forEach(([key, dp]) => {
      if (dp.composite) return;
      expect(dp.description, `${key}.description`).toContain("Caller Doesn't Know");
    });
  });

  it("all enum data points have 'Caller Doesn\\'t Know' in choices", () => {
    Object.entries(DATA_POINT_REGISTRY).forEach(([key, dp]) => {
      if (dp.type !== "enum" || dp.composite) return;
      expect(dp.choices, `${key}.choices`).toContain("Caller Doesn't Know");
    });
  });

  it("scheduling sub-variables have 'Caller Doesn\\'t Know' in choices", () => {
    const scheduling = DATA_POINT_REGISTRY.scheduling;
    expect(scheduling.variables).toBeDefined();
    scheduling.variables!.forEach((v) => {
      expect(v.choices, `${v.variableName}.choices`).toContain("Caller Doesn't Know");
    });
  });
});

describe("custom data point defaults include 'Caller Doesn\\'t Know' handling", () => {
  it("default description, conversationPrompt, and forwardCondition handle don't know", () => {
    const resolved = resolveDataPoints([{ variableName: "my_var" }]);
    expect(resolved[0].description).toContain("Caller Doesn't Know");
    expect(resolved[0].conversationPrompt).toMatch(/don't know/i);
    expect(resolved[0].forwardCondition).toMatch(/don't know/i);
  });
});

// ── generateAgent (single-path) ──────────────────────────────────────────────

describe("generateAgent (single-path)", () => {
  it("generates valid agent with basic data points", () => {
    const { agent, resolved, resolvedPaths } = generateAgent(
      baseConfig,
      ["full_name", "phone_number", "city"],
    );

    expect(resolved).toHaveLength(3);
    expect(resolvedPaths).toBeUndefined();

    const flow = agent.conversationFlow as any;
    expect(flow.nodes.length).toBeGreaterThan(10);
    expect(flow.start_node_id).toBeTruthy();
  });

  it("creates single intro edge in single-path mode", () => {
    const { agent } = generateAgent(baseConfig, ["full_name"]);
    const flow = agent.conversationFlow as any;
    const intro = flow.nodes.find((n: any) => n.name === "Intro");
    expect(intro.edges).toHaveLength(1);
  });

  it("creates Extract → Router → Collect/Confirm chain", () => {
    const { agent } = generateAgent(baseConfig, ["full_name", "city"]);
    const flow = agent.conversationFlow as any;
    const names = flow.nodes.map((n: any) => n.name);

    expect(names).toContain("Extract All Variables");
    expect(names).toContain("Variables Router");
    expect(names).toContain("Collect Full Name");
    expect(names).toContain("Confirm Full Name");
    expect(names).toContain("Collect City");
    expect(names).toContain("Confirm City");
  });

  it("router else-edge points to Close", () => {
    const { agent } = generateAgent(baseConfig, ["full_name"]);
    const flow = agent.conversationFlow as any;
    const router = flow.nodes.find((n: any) => n.name === "Variables Router");
    const close = flow.nodes.find((n: any) => n.name === "Close");
    expect(router.else_edge.destination_node_id).toBe(close.id);
  });

  it("generates all shared nodes", () => {
    const { agent } = generateAgent(baseConfig, ["full_name"]);
    const flow = agent.conversationFlow as any;
    const names = flow.nodes.map((n: any) => n.name);

    expect(names).toContain("Intro");
    expect(names).toContain("Admin/FAQ");
    expect(names).toContain("Human Request");
    expect(names).toContain("Close");
    expect(names).toContain("Closing Remarks");
    expect(names).toContain("Closing Statement");
    expect(names).toContain("irrelevantGaurdrail");
    expect(names).toContain("Emergency Gaurd Rail");
    expect(names).toContain("Polite Hangup");
    expect(names.filter((n: string) => n === "End Call")).toHaveLength(2);
  });
});

// ── generateAgent (multi-path) ───────────────────────────────────────────────

describe("generateAgent (multi-path)", () => {
  const paths = [
    {
      name: "Emergency Dispatch",
      transitionCondition: "Truck is broken down",
      dataPoints: ["company_name", "full_name", "phone_number", "truck_number", "breakdown_location"] as any[],
    },
    {
      name: "Shop Service",
      transitionCondition: "Wants to schedule maintenance",
      dataPoints: ["full_name", "phone_number", "vehicle_type"] as any[],
    },
  ];

  it("returns resolvedPaths for multi-path", () => {
    const { resolvedPaths } = generateAgent(baseConfig, [], paths);
    expect(resolvedPaths).toHaveLength(2);
    expect(resolvedPaths![0].name).toBe("Emergency Dispatch");
    expect(resolvedPaths![0].resolved).toHaveLength(5);
    expect(resolvedPaths![1].name).toBe("Shop Service");
    expect(resolvedPaths![1].resolved).toHaveLength(3);
  });

  it("returns all resolved data points flattened", () => {
    const { resolved } = generateAgent(baseConfig, [], paths);
    // 5 + 3 = 8 total
    expect(resolved).toHaveLength(8);
  });

  it("creates one intro edge per path", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    const intro = flow.nodes.find((n: any) => n.name === "Intro");
    expect(intro.edges).toHaveLength(2);
    expect(intro.edges[0].transition_condition.prompt).toBe("Truck is broken down");
    expect(intro.edges[1].transition_condition.prompt).toBe("Wants to schedule maintenance");
  });

  it("creates per-path Transition nodes", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    const names = flow.nodes.map((n: any) => n.name);
    expect(names).toContain("Transition (Emergency Dispatch)");
    expect(names).toContain("Transition (Shop Service)");
    // No unnamed "Conversation" transition
    expect(names).not.toContain("Conversation");
  });

  it("creates per-path Extract and Router nodes", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    const names = flow.nodes.map((n: any) => n.name);
    expect(names).toContain("Extract All Variables (Emergency Dispatch)");
    expect(names).toContain("Extract All Variables (Shop Service)");
    expect(names).toContain("Variables Router (Emergency Dispatch)");
    expect(names).toContain("Variables Router (Shop Service)");
  });

  it("adds _path_taken variable to each path extract", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;

    const extractE = flow.nodes.find((n: any) => n.name === "Extract All Variables (Emergency Dispatch)");
    const pathVar = extractE.variables.find((v: any) => v.name === "_path_taken");
    expect(pathVar).toBeDefined();
    expect(pathVar.description).toBe('Always set to "Emergency Dispatch".');

    const extractS = flow.nodes.find((n: any) => n.name === "Extract All Variables (Shop Service)");
    const pathVarS = extractS.variables.find((v: any) => v.name === "_path_taken");
    expect(pathVarS.description).toBe('Always set to "Shop Service".');
  });

  it("both routers point to shared Close node", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    const routerE = flow.nodes.find((n: any) => n.name === "Variables Router (Emergency Dispatch)");
    const routerS = flow.nodes.find((n: any) => n.name === "Variables Router (Shop Service)");
    const close = flow.nodes.find((n: any) => n.name === "Close");
    expect(routerE.else_edge.destination_node_id).toBe(close.id);
    expect(routerS.else_edge.destination_node_id).toBe(close.id);
  });

  it("shared nodes are generated once", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    const names = flow.nodes.map((n: any) => n.name);
    expect(names.filter((n: string) => n === "Close")).toHaveLength(1);
    expect(names.filter((n: string) => n === "Admin/FAQ")).toHaveLength(1);
    expect(names.filter((n: string) => n === "Closing Remarks")).toHaveLength(1);
  });

  it("FAQ forward-intent edge points to Intro in multi-path", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    const intro = flow.nodes.find((n: any) => n.name === "Intro");
    expect(faq.edges[0].destination_node_id).toBe(intro.id);
  });

  it("FAQ forward-intent edge points to Transition in single-path", () => {
    const { agent } = generateAgent(baseConfig, ["full_name"]);
    const flow = agent.conversationFlow as any;
    const faq = flow.nodes.find((n: any) => n.name === "Admin/FAQ");
    const transition = flow.nodes.find((n: any) => n.name === "Conversation");
    expect(faq.edges[0].destination_node_id).toBe(transition.id);
  });

  it("each path has correct number of Collect/Confirm pairs", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    // Path 1: 5 data points → 5 Collect + 5 Confirm = 10
    const collectNodes = flow.nodes.filter((n: any) => n.name.startsWith("Collect "));
    // full_name appears in both paths, so "Collect Full Name" appears twice
    expect(collectNodes.length).toBe(8); // 5 + 3

    const confirmNodes = flow.nodes.filter((n: any) => n.name.startsWith("Confirm "));
    expect(confirmNodes.length).toBe(8);
  });

  it("all node IDs are unique", () => {
    const { agent } = generateAgent(baseConfig, [], paths);
    const flow = agent.conversationFlow as any;
    const ids = flow.nodes.map((n: any) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
