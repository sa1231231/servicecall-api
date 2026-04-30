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
});
