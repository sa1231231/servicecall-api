import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── Mocks ──────────────────────────────────────────────────────────────────

const { mockGetClientDocument } = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
}));

vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...args: any[]) => mockGetClientDocument(...args),
}));

const { mockParseConversationFlow } = vi.hoisted(() => ({
  mockParseConversationFlow: vi.fn(),
}));

vi.mock("../../../lib/node-parser.js", () => ({
  parseConversationFlow: (...args: any[]) => mockParseConversationFlow(...args),
}));

import { exportAgentHandler } from "../export-agent.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockReq(slug: string): Request {
  return { params: { slug } } as any;
}

function mockRes(): Response & { _status: number; _json: any; _headers: Record<string, string> } {
  const res: any = { _status: 200, _json: null, _headers: {} };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  res.setHeader = (key: string, val: string) => { res._headers[key] = val; };
  return res;
}

function makeParsed(overrides: Record<string, any> = {}) {
  return {
    introNode: { raw: { edges: [] } },
    faqNode: null,
    allNodes: [],
    paths: [],
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exportAgentHandler", () => {
  it("returns 404 when client not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = mockRes();
    await exportAgentHandler(mockReq("nonexistent"), res);
    expect(res._status).toBe(404);
    expect(res._json.error).toContain("not found");
  });

  it("returns 400 when no agent IDs", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_ids: [] });
    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("No agent IDs");
  });

  it("returns 400 when no canonical JSON", async () => {
    mockGetClientDocument.mockResolvedValue({
      agent_ids: ["agent_1"],
      retell_agents: {},
    });
    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("No canonical JSON");
  });

  it("exports config with correct structure", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test Co",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test Agent" } },
      dispatch_text_numbers: ["+15551234567"],
      dispatch_call_number: null,
      dispatch_email: ["test@test.com"],
      summary_agent_id: null,
      shadow_mode: false,
      hide_not_mentioned: true,
      phone_fallback_to_caller: true,
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      paths: [{
        name: "service_request",
        transitionNode: { id: "tn_1" },
        routerNode: { raw: { edges: [] } },
        dataChain: [{
          variableName: "full_name",
          label: "Full Name",
          conversationPrompt: "What is your name?",
          forwardCondition: "when name given",
          collectNode: { id: "cn_1" },
          variableDefs: [{ type: "string", description: "Name" }],
        }],
      }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test-co"), res);

    expect(res._status).toBe(200);
    expect(res._json.version).toBe(1);
    expect(res._json.type).toBe("servicecall-agent-config");
    expect(res._json.business.businessName).toBe("Test Agent");
    expect(res._json.paths).toHaveLength(1);
    expect(res._json.paths[0].name).toBe("service_request");
    expect(res._json.paths[0].dataPoints).toHaveLength(1);
    expect(res._json.paths[0].dataPoints[0].variableName).toBe("full_name");
    expect(res._json.client.name).toBe("Test Co");
    expect(res._json.client.dispatch_email).toEqual(["test@test.com"]);
    expect(res._json.client.hide_not_mentioned).toBe(true);
  });

  it("sets download headers", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed());

    const res = mockRes();
    await exportAgentHandler(mockReq("test-co"), res);

    expect(res._headers["Content-Type"]).toBe("application/json");
    expect(res._headers["Content-Disposition"]).toContain("test-co-config.json");
  });

  it("detects live_transfer mode", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed({
      allNodes: [{ name: "Transfer Call" }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.human_request_mode).toBe("live_transfer");
  });

  it("defaults to callback mode", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed({
      allNodes: [{ name: "Collect Data" }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.human_request_mode).toBe("callback");
  });

  it("extracts FAQ knowledge base", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    const faqText = "Your goal is to answer administrative and general questions briefly and accurately.\n\nWe are open 9-5.";
    mockParseConversationFlow.mockReturnValue(makeParsed({
      faqNode: { raw: { instruction: { text: faqText } } },
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.faqKnowledgeBase).toBe("We are open 9-5.");
  });

  it("includes choices when present on variable def", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed({
      paths: [{
        name: "path1",
        transitionNode: { id: "tn" },
        routerNode: { raw: { edges: [] } },
        dataChain: [{
          variableName: "property_type",
          label: "Property Type",
          conversationPrompt: "Residential or commercial?",
          forwardCondition: "",
          collectNode: { id: "cn" },
          variableDefs: [{ type: "enum", choices: ["Residential", "Commercial"], description: "" }],
        }],
      }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.paths[0].dataPoints[0].choices).toEqual(["Residential", "Commercial"]);
  });

  it("includes orphan flag in exported data points", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed({
      paths: [{
        name: "path1",
        transitionNode: { id: "tn" },
        routerNode: { raw: { edges: [] } },
        dataChain: [
          {
            variableName: "full_name",
            label: "Full Name",
            conversationPrompt: "Ask for name",
            forwardCondition: "Name given",
            collectNode: { id: "cn1" },
            variableDefs: [{ type: "string", description: "Name" }],
          },
          {
            variableName: "is_loaded",
            label: "Is Loaded",
            conversationPrompt: "",
            forwardCondition: "",
            collectNode: { id: "cn2" },
            variableDefs: [{ type: "boolean", description: "Loaded check" }],
            orphan: true,
          },
        ],
      }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.paths[0].dataPoints).toHaveLength(2);
    expect(res._json.paths[0].dataPoints[0].orphan).toBeUndefined();
    expect(res._json.paths[0].dataPoints[1].orphan).toBe(true);
    expect(res._json.paths[0].dataPoints[1].variableName).toBe("is_loaded");
  });

  it("returns 500 when parser throws", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockImplementation(() => { throw new Error("Parse error"); });

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._status).toBe(500);
    expect(res._json.error).toContain("Parse error");
  });

  it("extracts per-path transitionCondition from intro edges", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      introNode: {
        raw: {
          edges: [
            {
              destination_node_id: "transition_a",
              transition_condition: { type: "prompt", prompt: "When the caller says A" },
            },
            {
              destination_node_id: "transition_b",
              transition_condition: { type: "prompt", prompt: "When the caller says B" },
            },
          ],
        },
      },
      paths: [
        {
          name: "path_a",
          transitionNode: { id: "transition_a" },
          routerNode: { raw: { edges: [] } },
          dataChain: [],
        },
        {
          name: "path_b",
          transitionNode: { id: "transition_b" },
          routerNode: { raw: { edges: [] } },
          dataChain: [],
        },
      ],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.paths[0].transitionCondition).toBe("When the caller says A");
    expect(res._json.paths[1].transitionCondition).toBe("When the caller says B");
  });

  it("leaves transitionCondition empty when intro has no matching edge", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      introNode: { raw: { edges: [{ destination_node_id: "other_node" }] } },
      paths: [{
        name: "p",
        transitionNode: { id: "transition_a" },
        routerNode: { raw: { edges: [] } },
        dataChain: [],
      }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.paths[0].transitionCondition).toBe("");
  });

  it("reconstructs branch conditions from router edges (filtering sentinels)", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      paths: [{
        name: "path_a",
        transitionNode: { id: "tn" },
        routerNode: {
          raw: {
            edges: [
              {
                destination_node_id: "collect_node_1",
                transition_condition: {
                  type: "equation",
                  equations: [
                    // Sentinel "is missing" check on this var — filtered
                    { left: "{{warranty_status}}", operator: "exists" },
                    // phone_number_collected sentinel — filtered
                    { left: "{{phone_number_collected}}", operator: "==", right: "true" },
                    // Self-variable-def reference — filtered
                    { left: "{{warranty_status}}", operator: "!=", right: "x" },
                    // Sentinel "Not Mentioned" — filtered
                    { left: "{{payment_method}}", operator: "!=", right: "Not Mentioned" },
                    // Sentinel "Caller Doesn't Know" — filtered
                    { left: "{{payment_method}}", operator: "!=", right: "Caller Doesn't Know" },
                    // The meaningful branch condition
                    { left: "{{property_type}}", operator: "==", right: "Residential" },
                  ],
                },
              },
            ],
          },
        },
        dataChain: [{
          variableName: "warranty_status",
          label: "Warranty",
          conversationPrompt: "Ask",
          forwardCondition: "Got it",
          collectNode: { id: "collect_node_1" },
          variableDefs: [{ name: "warranty_status", type: "string", description: "" }],
        }],
      }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    const dp = res._json.paths[0].dataPoints[0];
    expect(dp._branchConditions).toBeDefined();
    expect(dp._branchConditions).toHaveLength(1);
    expect(dp._branchConditions[0]).toEqual({
      variable: "property_type",
      operator: "==",
      value: "Residential",
    });
  });

  it("omits _branchConditions when no meaningful equations remain", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      paths: [{
        name: "p",
        transitionNode: { id: "tn" },
        routerNode: {
          raw: {
            edges: [{
              destination_node_id: "cn",
              transition_condition: {
                type: "equation",
                equations: [
                  { left: "{{x}}", operator: "exists" }, // self-ref → filtered
                ],
              },
            }],
          },
        },
        dataChain: [{
          variableName: "x",
          label: "X",
          conversationPrompt: "ask",
          forwardCondition: "ok",
          collectNode: { id: "cn" },
          variableDefs: [{ name: "x", type: "string", description: "" }],
        }],
      }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.paths[0].dataPoints[0]._branchConditions).toBeUndefined();
  });

  it("handles non-equation transition conditions on router (no branch info added)", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      paths: [{
        name: "p",
        transitionNode: { id: "tn" },
        routerNode: {
          raw: {
            edges: [{
              destination_node_id: "cn",
              transition_condition: { type: "prompt", prompt: "Always" },
            }],
          },
        },
        dataChain: [{
          variableName: "x",
          label: "X",
          conversationPrompt: "ask",
          forwardCondition: "ok",
          collectNode: { id: "cn" },
          variableDefs: [{ name: "x", type: "string", description: "" }],
        }],
      }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.paths[0].dataPoints[0]._branchConditions).toBeUndefined();
  });

  it("extracts FAQ without prefix when prefix is missing", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed({
      faqNode: { raw: { instruction: { text: "Custom FAQ without standard prefix" } } },
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.faqKnowledgeBase).toBe("Custom FAQ without standard prefix");
  });

  it("falls back to client name when agent_name is missing on canonical", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test Co Inc",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: {} }, // no agent_name
    });
    mockParseConversationFlow.mockReturnValue(makeParsed());

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.businessName).toBe("Test Co Inc");
  });

  it("includes dispatch_by_type when present on the doc", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
      dispatch_by_type: {
        emergency: { dispatch_text_numbers: ["+15558888888"] },
      },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed());

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.client.dispatch_by_type).toEqual({
      emergency: { dispatch_text_numbers: ["+15558888888"] },
    });
  });

  it("defaults phone_fallback_to_caller to true when not set", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed());

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.client.phone_fallback_to_caller).toBe(true);
  });

  it("preserves phone_fallback_to_caller=false when explicitly set", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
      phone_fallback_to_caller: false,
    });
    mockParseConversationFlow.mockReturnValue(makeParsed());

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.client.phone_fallback_to_caller).toBe(false);
  });

  it("returns 400 when retell_agents is missing entirely", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      // no retell_agents
    });

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._status).toBe(400);
    expect(res._json.error).toContain("No canonical JSON");
  });

  it("exports closing prompts from canonical Close / Closing Remarks / Closing Statement nodes", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      allNodes: [
        { name: "Close", raw: { instruction: { text: "Thanks {{business_name}}!" } } },
        { name: "Closing Remarks", raw: { instruction: { text: "Have a great day." } } },
        { name: "Closing Statement", raw: { instruction: { text: "Bye now!" } } },
      ],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.closePrompt).toBe("Thanks {{business_name}}!");
    expect(res._json.business.closingRemarksPrompt).toBe("Have a great day.");
    expect(res._json.business.closingStatementText).toBe("Bye now!");
  });

  it("omits closing prompts when nodes are absent or empty", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed({
      allNodes: [{ name: "Close", raw: { instruction: { text: "" } } }],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.closePrompt).toBeUndefined();
    expect(res._json.business.closingRemarksPrompt).toBeUndefined();
    expect(res._json.business.closingStatementText).toBeUndefined();
    expect(res._json.business.liveTransferRecoveryPrompt).toBeUndefined();
  });

  it("exports liveTransferRecoveryPrompt from the Live Transfer Recovery node", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });
    mockParseConversationFlow.mockReturnValue(makeParsed({
      allNodes: [
        { name: "Live Transfer Recovery", raw: { instruction: { text: "Sorry — staff are busy. We'll call you back." } } },
      ],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.business.liveTransferRecoveryPrompt).toBe("Sorry — staff are busy. We'll call you back.");
  });

  it("exports per-path end_mode from parsed.paths[i].endMode", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
    });

    mockParseConversationFlow.mockReturnValue(makeParsed({
      paths: [
        {
          name: "emergency",
          transitionNode: { id: "tn1" },
          routerNode: { raw: { edges: [] } },
          dataChain: [],
          endMode: "transfer",
        },
        {
          name: "quote",
          transitionNode: { id: "tn2" },
          routerNode: { raw: { edges: [] } },
          dataChain: [],
          endMode: "callback",
        },
      ],
    }));

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.paths[0].end_mode).toBe("transfer");
    expect(res._json.paths[1].end_mode).toBe("callback");
  });

  it("exports client.path_end_modes + dispatch_call_overrides + webhook_url + notification_greeting", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Test",
      agent_ids: ["agent_1"],
      retell_agents: { agent_1: { agent_name: "Test" } },
      path_end_modes: { emergency: "transfer" },
      dispatch_call_overrides: { "+15551111111": "+15552222222" },
      webhook_url: "https://example.com/hook",
      notification_greeting: "Hi {{business_name}},",
      weekly_report_enabled: true,
      dispatch_cc: "cc@example.com",
      outbound_from_number: "+15553334444",
    });
    mockParseConversationFlow.mockReturnValue(makeParsed());

    const res = mockRes();
    await exportAgentHandler(mockReq("test"), res);

    expect(res._json.client.path_end_modes).toEqual({ emergency: "transfer" });
    expect(res._json.client.dispatch_call_overrides).toEqual({ "+15551111111": "+15552222222" });
    expect(res._json.client.webhook_url).toBe("https://example.com/hook");
    expect(res._json.client.notification_greeting).toBe("Hi {{business_name}},");
    expect(res._json.client.weekly_report_enabled).toBe(true);
    expect(res._json.client.dispatch_cc).toBe("cc@example.com");
    expect(res._json.client.outbound_from_number).toBe("+15553334444");
  });
});
