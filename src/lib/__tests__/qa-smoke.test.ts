import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// qa-smoke.ts imports config.js, which calls requireEnv("ROOT_PASSWORD") at
// module load. Mock it so the import chain doesn't blow up in test workers
// that don't have the full env set.
vi.mock("../../config.js", () => ({
  config: { RETELL_API_KEY: "retell_test" },
}));

import {
  checkGreetingBusinessName,
  checkDataPointsInFlow,
  checkNotificationConfigComplete,
  checkMessageTypeResolves,
  checkRequiredFieldsSatisfiable,
  buildSyntheticVariables,
  runSmokeTest,
} from "../qa-smoke.js";
import type { RetellAgentSnapshot } from "../retell-sync.js";
import type { JsonClientEntry } from "../../config/client-store.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Record<string, unknown> = {}): RetellAgentSnapshot {
  return {
    agentId: "agent_test",
    agentName: "Test Agent",
    conversationFlowId: "cf_test",
    variables: [
      { key: "full_name", label: "Full Name" },
      { key: "phone_number", label: "Phone Number" },
      { key: "problem_description", label: "Problem Description" },
    ],
    canonicalJson: {
      conversationFlow: {
        start_node_id: "node-intro",
        global_prompt: "You are Anthony, an inbound receptionist for Test Plumbing.",
        nodes: [
          {
            id: "node-intro",
            type: "conversation",
            name: "Intro",
            instruction: {
              type: "prompt",
              text: 'Welcome the caller: "Thank you for calling Test Plumbing, this is Anthony."',
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

function makeClientDoc(overrides: Record<string, unknown> = {}): JsonClientEntry & { _id: string } {
  return {
    _id: "test-plumbing",
    name: "Test Plumbing",
    agent_id: "agent_test",
    dispatch_text_numbers: ["+15551234567"],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: ["dispatch@test.com"],
    dispatch_cc: null,
    message_types: {
      service_request: {
        label: "New Service Request",
        subject_template: "Service Request: {{full_name}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "problem_description", label: "Problem" },
        ],
      },
    },
    default_message_type: "service_request",
    ...overrides,
  } as JsonClientEntry & { _id: string };
}

// ── greeting_has_business_name ───────────────────────────────────────────────

describe("checkGreetingBusinessName", () => {
  it("passes when name is in both global prompt and intro node", () => {
    const result = checkGreetingBusinessName(makeSnapshot(), makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("global prompt and intro node");
  });

  it("passes when name is only in global prompt", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are Anthony, an inbound receptionist for Test Plumbing.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Welcome the caller." },
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("global prompt");
  });

  it("passes when name is only in intro node", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are a receptionist.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Thank you for calling Test Plumbing." },
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("intro node");
  });

  it("fails when name is missing from both", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are a receptionist.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Welcome, how can I help?" },
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("not found");
  });

  it("matches case-insensitively", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are Anthony for TEST PLUMBING.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Welcome." },
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("pass");
  });

  it("handles string instruction format", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "Receptionist.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: "Thank you for calling Test Plumbing.",
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("pass");
  });

  it("fails when no conversation flow", () => {
    const snapshot = makeSnapshot({ canonicalJson: {} });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("No conversation flow");
  });

  it("passes when business name is a {{business_name}} variable", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are Anthony, an inbound receptionist for {{business_name}}.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Welcome the caller." },
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("variable");
    expect(result.message).toContain("business_name");
  });

  it("passes when {{company_name}} variable is in intro node", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are a receptionist.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Thank you for calling {{company_name}}." },
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("company_name");
  });

  it("fails when variable reference is not business/company/client related", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are {{agent_name}} receptionist.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Welcome." },
            },
          ],
        },
      },
    });
    const result = checkGreetingBusinessName(snapshot, makeClientDoc());
    expect(result.status).toBe("fail");
  });

  it("matches word parts of business name with special characters", () => {
    const snapshot = makeSnapshot({
      canonicalJson: {
        conversationFlow: {
          start_node_id: "node-intro",
          global_prompt: "You are Anthony for J & A Fleet Maintenance.",
          nodes: [
            {
              id: "node-intro",
              type: "conversation",
              instruction: { type: "prompt", text: "Welcome." },
            },
          ],
        },
      },
    });
    const client = makeClientDoc({ name: "J&A Fleet Maintenance" });
    const result = checkGreetingBusinessName(snapshot, client);
    expect(result.status).toBe("pass");
  });
});

// ── data_points_in_flow ──────────────────────────────────────────────────────

describe("checkDataPointsInFlow", () => {
  it("passes when all fields are present in flow variables", () => {
    const result = checkDataPointsInFlow(makeSnapshot(), makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("3 notification fields");
  });

  it("fails when a field is missing from flow variables", () => {
    const snapshot = makeSnapshot({
      variables: [
        { key: "full_name", label: "Full Name" },
        { key: "phone_number", label: "Phone" },
        // missing problem_description
      ],
    });
    const result = checkDataPointsInFlow(snapshot, makeClientDoc());
    expect(result.status).toBe("fail");
    expect(result.message).toContain("problem_description");
  });

  it("passes with empty message type fields", () => {
    const client = makeClientDoc({
      message_types: {
        service_request: {
          label: "SR",
          subject_template: "SR",
          fields: [],
        },
      },
    });
    const result = checkDataPointsInFlow(makeSnapshot(), client);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("0 notification fields");
  });
});

// ── notification_config_complete ─────────────────────────────────────────────

describe("checkNotificationConfigComplete", () => {
  it("passes with SMS and email configured", () => {
    const result = checkNotificationConfigComplete(makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 SMS");
    expect(result.message).toContain("1 email");
  });

  it("passes with SMS only", () => {
    const result = checkNotificationConfigComplete(makeClientDoc({ dispatch_email: null }));
    expect(result.status).toBe("pass");
  });

  it("fails with no dispatch channels", () => {
    const result = checkNotificationConfigComplete(
      makeClientDoc({ dispatch_text_numbers: [], dispatch_email: null }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("no dispatch channels");
  });

  it("fails with no message types", () => {
    const result = checkNotificationConfigComplete(
      makeClientDoc({ message_types: {} }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("no message_types");
  });

  it("fails when default_message_type is missing from message_types", () => {
    const result = checkNotificationConfigComplete(
      makeClientDoc({ default_message_type: "nonexistent" }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("nonexistent");
  });
});

// ── message_type_resolves ────────────────────────────────────────────────────

describe("checkMessageTypeResolves", () => {
  it("passes with no rules (defaults)", () => {
    const result = checkMessageTypeResolves(makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("service_request");
  });

  it("passes with a binary resolve_rule", () => {
    const client = makeClientDoc({
      resolve_rule: { field: "is_emergency", equals: "true", then: "emergency", else: "service_request" },
      message_types: {
        emergency: { label: "Emergency", subject_template: "E", fields: [{ key: "full_name", label: "Name" }] },
        service_request: { label: "SR", subject_template: "SR", fields: [{ key: "full_name", label: "Name" }] },
      },
    });
    const result = checkMessageTypeResolves(client);
    expect(result.status).toBe("pass");
  });

  it("passes with multi-path resolve_rules", () => {
    const client = makeClientDoc({
      resolve_rules: [
        { field: "vehicle_type", equals: "Semi", then: "heavy" },
        { field: "vehicle_type", equals: "Pickup", then: "light" },
      ],
      message_types: {
        heavy: { label: "Heavy", subject_template: "H", fields: [{ key: "full_name", label: "Name" }] },
        light: { label: "Light", subject_template: "L", fields: [{ key: "full_name", label: "Name" }] },
        service_request: { label: "SR", subject_template: "SR", fields: [{ key: "full_name", label: "Name" }] },
      },
    });
    const result = checkMessageTypeResolves(client);
    expect(result.status).toBe("pass");
  });

  it("fails when resolution points to invalid key", () => {
    const client = makeClientDoc({
      resolve_rule: { field: "is_emergency", equals: "true", then: "nonexistent", else: "service_request" },
    });
    // With synthetic vars, is_emergency = "false", so resolves to "service_request" (valid)
    // But empty vars resolves to "service_request" too (the else). Let's force it:
    const client2 = makeClientDoc({
      resolve_rule: { field: "x", equals: "y", then: "service_request", else: "missing_type" },
    });
    const result = checkMessageTypeResolves(client2);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("missing_type");
  });
});

// ── required_fields_satisfiable ──────────────────────────────────────────────

describe("checkRequiredFieldsSatisfiable", () => {
  it("passes when all required fields are in flow variables", () => {
    const client = makeClientDoc({
      message_types: {
        service_request: {
          label: "SR",
          subject_template: "SR",
          fields: [
            { key: "full_name", label: "Name", required: true },
            { key: "phone_number", label: "Phone" },
          ],
        },
      },
    });
    const result = checkRequiredFieldsSatisfiable(makeSnapshot(), client);
    expect(result.status).toBe("pass");
    expect(result.message).toContain("1 required field");
  });

  it("fails when required field is not in flow variables", () => {
    const client = makeClientDoc({
      message_types: {
        service_request: {
          label: "SR",
          subject_template: "SR",
          fields: [
            { key: "missing_field", label: "Missing", required: true },
          ],
        },
      },
    });
    const result = checkRequiredFieldsSatisfiable(makeSnapshot(), client);
    expect(result.status).toBe("fail");
    expect(result.message).toContain("missing_field");
  });

  it("passes when no fields are required", () => {
    const result = checkRequiredFieldsSatisfiable(makeSnapshot(), makeClientDoc());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("0 required field");
  });
});

// ── buildSyntheticVariables ──────────────────────────────────────────────────

describe("buildSyntheticVariables", () => {
  it("returns known values for standard field keys", () => {
    const vars = buildSyntheticVariables(makeClientDoc());
    expect(vars.full_name).toBe("QA Smoke Test");
    expect(vars.phone_number).toBe("555-000-0000");
    expect(vars.problem_description).toContain("smoke test");
  });

  it("returns fallback for unknown field keys", () => {
    const client = makeClientDoc({
      message_types: {
        service_request: {
          label: "SR",
          subject_template: "SR",
          fields: [{ key: "custom_widget", label: "Widget" }],
        },
      },
    });
    const vars = buildSyntheticVariables(client);
    expect(vars.custom_widget).toBe("test_value");
  });

  it("sets resolve_rule field for binary rule", () => {
    const client = makeClientDoc({
      resolve_rule: { field: "is_emergency", equals: "true", then: "emergency", else: "service_request" },
    });
    const vars = buildSyntheticVariables(client);
    expect(vars.is_emergency).toBe("false");
  });

  it("sets resolve_rules field for multi-path rules", () => {
    const client = makeClientDoc({
      resolve_rules: [
        { field: "vehicle_type", equals: "Semi", then: "heavy" },
      ],
    });
    const vars = buildSyntheticVariables(client);
    expect(vars.vehicle_type).toBe("Semi");
  });
});

// ── runSmokeTest ─────────────────────────────────────────────────────────────

function makeRetell(): any {
  return {
    agent: { retrieve: vi.fn() },
    conversationFlow: { retrieve: vi.fn() },
  };
}

describe("runSmokeTest", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses stored canonical JSON when available (no Retell fetch)", async () => {
    const retell = makeRetell();
    const client = makeClientDoc({
      retell_agents: {
        agent_test: {
          agent_name: "Stored Agent",
          conversationFlow: {
            start_node_id: "node-intro",
            global_prompt: "for Test Plumbing.",
            nodes: [
              {
                id: "node-intro",
                type: "conversation",
                instruction: { type: "prompt", text: "Welcome to Test Plumbing." },
              },
              {
                name: "Extract All Variables",
                type: "extract_dynamic_variables",
                variables: [
                  { name: "full_name" },
                  { name: "phone_number" },
                  { name: "problem_description" },
                ],
              },
            ],
          },
        },
      },
    } as any);

    const report = await runSmokeTest(retell, client);

    expect(retell.agent.retrieve).not.toHaveBeenCalled();
    expect(report.slug).toBe("test-plumbing");
    expect(report.agent_id).toBe("agent_test");
    expect(report.checks.find((c) => c.check === "agent_reachable")?.status).toBe("pass");
    expect(report.checks.find((c) => c.check === "agent_reachable")?.message).toContain("loaded from config");
    expect(report.summary.total).toBe(6); // 6 default checks
    expect(report.overall).toBe("pass");
  });

  it("falls back to live Retell fetch when stored JSON is missing", async () => {
    const retell = makeRetell();
    retell.agent.retrieve.mockResolvedValue({
      agent_id: "agent_test",
      agent_name: "Live Agent",
      response_engine: { type: "conversation-flow", conversation_flow_id: "cf_1" },
    });
    retell.conversationFlow.retrieve.mockResolvedValue({
      conversation_flow_id: "cf_1",
      start_node_id: "intro",
      global_prompt: "for Test Plumbing",
      nodes: [
        { id: "intro", type: "conversation", instruction: { type: "prompt", text: "Hi from Test Plumbing" } },
        {
          name: "Extract All Variables",
          type: "extract_dynamic_variables",
          variables: [{ name: "full_name" }, { name: "phone_number" }, { name: "problem_description" }],
        },
      ],
    });

    const client = makeClientDoc(); // no retell_agents
    const report = await runSmokeTest(retell, client);

    expect(retell.agent.retrieve).toHaveBeenCalledWith("agent_test");
    expect(report.checks.find((c) => c.check === "agent_reachable")?.status).toBe("pass");
    expect(report.checks.find((c) => c.check === "agent_reachable")?.message).toContain("not yet synced");
  });

  it("marks agent_reachable as fail and skips downstream checks when Retell errors", async () => {
    const retell = makeRetell();
    retell.agent.retrieve.mockRejectedValue(new Error("agent not found"));

    const client = makeClientDoc();
    const report = await runSmokeTest(retell, client);

    expect(report.checks.find((c) => c.check === "agent_reachable")?.status).toBe("fail");
    // 5 checks should be skipped
    const skipped = report.checks.filter((c) => c.status === "skip");
    expect(skipped).toHaveLength(5);
    expect(report.overall).toBe("fail");
  });

  it("computes a summary with pass/fail/warn/skip counts", async () => {
    const retell = makeRetell();
    retell.agent.retrieve.mockRejectedValue(new Error("nope"));

    const client = makeClientDoc();
    const report = await runSmokeTest(retell, client);

    expect(report.summary.total).toBe(report.checks.length);
    expect(report.summary.fail).toBeGreaterThanOrEqual(1); // at least agent_reachable
    expect(report.summary.skip).toBe(5);
  });

  it("includes timestamp and duration_ms", async () => {
    const retell = makeRetell();
    retell.agent.retrieve.mockRejectedValue(new Error("x"));
    const client = makeClientDoc();

    const before = Date.now();
    const report = await runSmokeTest(retell, client);

    expect(new Date(report.timestamp).getTime()).toBeGreaterThanOrEqual(before);
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("notify=true and shadow_mode=false → notification_fires fails fast", async () => {
    const retell = makeRetell();
    const client = makeClientDoc({
      retell_agents: {
        agent_test: {
          conversationFlow: {
            start_node_id: "intro",
            global_prompt: "Test Plumbing",
            nodes: [
              { id: "intro", type: "conversation", instruction: { type: "prompt", text: "Test Plumbing" } },
              {
                name: "Extract All Variables",
                type: "extract_dynamic_variables",
                variables: [{ name: "full_name" }, { name: "phone_number" }, { name: "problem_description" }],
              },
            ],
          },
        },
      },
      shadow_mode: false,
    } as any);

    const report = await runSmokeTest(retell, client, { notify: true });

    const fires = report.checks.find((c) => c.check === "notification_fires");
    expect(fires?.status).toBe("fail");
    expect(fires?.message).toContain("shadow_mode enabled");
    // No fetch attempted because shadow_mode guard fired first
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("notify=true and shadow_mode=true → calls post-hook URL", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ outcome: "shadow_dry_run" }),
    });

    const retell = makeRetell();
    const client = makeClientDoc({
      retell_agents: {
        agent_test: {
          conversationFlow: {
            start_node_id: "intro",
            global_prompt: "Test Plumbing",
            nodes: [
              { id: "intro", type: "conversation", instruction: { type: "prompt", text: "Test Plumbing" } },
              {
                name: "Extract All Variables",
                type: "extract_dynamic_variables",
                variables: [{ name: "full_name" }, { name: "phone_number" }, { name: "problem_description" }],
              },
            ],
          },
        },
      },
      shadow_mode: true,
    } as any);

    const report = await runSmokeTest(retell, client, {
      notify: true,
      postHookUrl: "http://test/post-hook",
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as any).mock.calls[0][0]).toBe("http://test/post-hook");
    const fires = report.checks.find((c) => c.check === "notification_fires");
    expect(fires?.status).toBe("pass");
    expect(fires?.message).toContain("dispatched");
  });

  it("notify=true and post-hook returns non-shadow outcome → fails", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ outcome: "dispatched" }),
    });

    const retell = makeRetell();
    const client = makeClientDoc({
      retell_agents: {
        agent_test: {
          conversationFlow: {
            start_node_id: "intro",
            global_prompt: "Test Plumbing",
            nodes: [
              { id: "intro", type: "conversation", instruction: { type: "prompt", text: "Test Plumbing" } },
              {
                name: "Extract All Variables",
                type: "extract_dynamic_variables",
                variables: [{ name: "full_name" }, { name: "phone_number" }, { name: "problem_description" }],
              },
            ],
          },
        },
      },
      shadow_mode: true,
    } as any);

    const report = await runSmokeTest(retell, client, {
      notify: true,
      postHookUrl: "http://test/post-hook",
    });

    const fires = report.checks.find((c) => c.check === "notification_fires");
    expect(fires?.status).toBe("fail");
    expect(fires?.message).toContain("Post-hook returned");
  });

  it("notify=true and fetch throws → fails with reach error", async () => {
    (global.fetch as any).mockRejectedValue(new Error("connection refused"));

    const retell = makeRetell();
    const client = makeClientDoc({
      retell_agents: {
        agent_test: {
          conversationFlow: {
            start_node_id: "intro",
            global_prompt: "Test Plumbing",
            nodes: [
              { id: "intro", type: "conversation", instruction: { type: "prompt", text: "Test Plumbing" } },
              {
                name: "Extract All Variables",
                type: "extract_dynamic_variables",
                variables: [{ name: "full_name" }, { name: "phone_number" }, { name: "problem_description" }],
              },
            ],
          },
        },
      },
      shadow_mode: true,
    } as any);

    const report = await runSmokeTest(retell, client, {
      notify: true,
      postHookUrl: "http://test/post-hook",
    });

    const fires = report.checks.find((c) => c.check === "notification_fires");
    expect(fires?.status).toBe("fail");
    expect(fires?.message).toContain("Failed to reach post-hook");
    expect(fires?.message).toContain("connection refused");
  });
});
