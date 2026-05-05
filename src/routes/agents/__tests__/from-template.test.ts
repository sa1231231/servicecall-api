import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockFlowCreate, mockAgentCreate, mockFlowDelete,
  mockProvisionPhoneNumber,
  mockGetDataPointDefaults,
  mockGenerateAgent,
  mockDeriveNotificationConfig,
  mockDeriveMultiPathNotificationConfig,
  mockExtractFlowParams,
  mockExtractAgentParams,
  mockPersistClient,
  mockLogPhoneEvent,
  mockGetSettings,
  mockGetWarmTransferAgentVersion,
  mockNotificationClients,
  mockLoadTemplate,
} = vi.hoisted(() => ({
  mockFlowCreate: vi.fn(),
  mockAgentCreate: vi.fn(),
  mockFlowDelete: vi.fn(),
  mockProvisionPhoneNumber: vi.fn(),
  mockGetDataPointDefaults: vi.fn(),
  mockGenerateAgent: vi.fn(),
  mockDeriveNotificationConfig: vi.fn(),
  mockDeriveMultiPathNotificationConfig: vi.fn(),
  mockExtractFlowParams: vi.fn() as any,
  mockExtractAgentParams: vi.fn() as any,
  mockPersistClient: vi.fn(),
  mockLogPhoneEvent: vi.fn(),
  mockGetSettings: vi.fn(),
  mockGetWarmTransferAgentVersion: vi.fn(),
  mockNotificationClients: {} as Record<string, any>,
  mockLoadTemplate: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  config: { RETELL_API_KEY: "test_key" },
}));

vi.mock("retell-sdk", () => ({
  default: class {
    conversationFlow = { create: mockFlowCreate, delete: mockFlowDelete };
    agent = { create: mockAgentCreate };
  },
}));

vi.mock("../../../_cache/clients.js", () => ({
  notificationClients: mockNotificationClients,
}));

vi.mock("../../../config/client-store.js", () => ({
  persistClient: (...a: any[]) => mockPersistClient(...a),
  updateClientField: vi.fn(),
}));

vi.mock("../../../lib/provision-number.js", () => ({
  provisionPhoneNumber: (...a: any[]) => mockProvisionPhoneNumber(...a),
}));

vi.mock("../../../lib/data-point-defaults.js", () => ({
  getDataPointDefaults: (...a: any[]) => mockGetDataPointDefaults(...a),
}));

vi.mock("../../../lib/agent-generator/index.js", () => ({
  generateAgent: (...a: any[]) => mockGenerateAgent(...a),
}));

vi.mock("../../../lib/agent-generator/warm-transfer-agent-version.js", () => ({
  getWarmTransferAgentVersion: (...a: any[]) => mockGetWarmTransferAgentVersion(...a),
}));

vi.mock("../../../lib/notification-config.js", () => ({
  toLabel: (k: string, l?: string) => l || k,
  deriveNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
  deriveMultiPathNotificationConfig: (...a: any[]) => mockDeriveMultiPathNotificationConfig(...a),
}));

vi.mock("../../../lib/retell-sync.js", () => ({
  extractFlowParams: (...a: any[]) => mockExtractFlowParams(...a),
  extractAgentParams: (...a: any[]) => mockExtractAgentParams(...a),
}));

vi.mock("../../../lib/phone-number-history.js", () => ({
  logPhoneEvent: (...a: any[]) => mockLogPhoneEvent(...a),
}));

vi.mock("../../../lib/settings.js", () => ({
  getSettings: (...a: any[]) => mockGetSettings(...a),
}));

// Mock loadTemplate at the import boundary used by the route handler.
vi.mock("../../../lib/agent-from-template.js", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/agent-from-template.js")>(
    "../../../lib/agent-from-template.js",
  );
  return {
    ...actual,
    loadTemplate: (...a: any[]) => mockLoadTemplate(...a),
  };
});

const { createFromTemplateHandler } = await import("../from-template.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function mockReq(body: any): Request {
  return { body } as any;
}
function mockRes() {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeTemplateExportConfig() {
  return {
    business: {
      businessName: "Original Plumbing",
      faqKnowledgeBase: "Original FAQ",
      introFinetuneExamples: [],
    },
    paths: [
      {
        name: "service",
        transitionCondition: "service request",
        dataPoints: [{ variableName: "full_name", label: "Name", type: "string" }],
        end_mode: "callback",
      },
    ],
    client: {
      slug: "original-plumbing",
      name: "Original Plumbing",
      dispatch_text_numbers: ["+15550001111"],
      dispatch_email: ["dispatch@original.com"],
      shadow_mode: true,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockNotificationClients)) delete mockNotificationClients[k];

  mockFlowCreate.mockResolvedValue({ conversation_flow_id: "cf_test" });
  mockAgentCreate.mockResolvedValue({ agent_id: "agent_test" });
  mockGetDataPointDefaults.mockResolvedValue({});
  mockGenerateAgent.mockReturnValue({
    agent: { conversationFlow: {}, agent_name: "X" },
    resolved: [{ variableName: "full_name", label: "Name" }],
    resolvedPaths: undefined,
  });
  mockDeriveNotificationConfig.mockReturnValue({
    name: "X",
    agent_id: "agent_test",
    dispatch_text_numbers: ["+15550001111"],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: ["dispatch@original.com"],
    dispatch_cc: null,
    message_types: {},
    default_message_type: "default",
  });
  mockPersistClient.mockResolvedValue({});
  mockProvisionPhoneNumber.mockResolvedValue({
    phoneNumber: "+15559998888",
    phoneNumberSid: "PN_test",
  });
  mockGetSettings.mockResolvedValue({ owner_phone: "+13017872841" });
  mockLogPhoneEvent.mockResolvedValue(undefined);
  mockGetWarmTransferAgentVersion.mockResolvedValue(7);
});

// ── Validation ─────────────────────────────────────────────────────────────

describe("createFromTemplateHandler — validation", () => {
  it("400 when template is missing", async () => {
    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({ business: { businessName: "X", faqKnowledgeBase: "y" } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("template");
  });

  it("400 when business.businessName is missing", async () => {
    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({ template: "plumber", business: { faqKnowledgeBase: "y" } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("businessName");
  });

  it("400 when business.faqKnowledgeBase is missing", async () => {
    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({ template: "plumber", business: { businessName: "X" } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("faqKnowledgeBase");
  });

  it("404 when template not found", async () => {
    mockLoadTemplate.mockResolvedValue(null);
    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({ template: "nonexistent", business: { businessName: "X", faqKnowledgeBase: "y" } }),
      res,
    );
    expect(res._status).toBe(404);
    expect(res._json.error).toContain("not found");
  });

  it("400 when template has no exportConfig", async () => {
    mockLoadTemplate.mockResolvedValue({
      _id: "x",
      name: "old",
      type: "template",
      formData: {},
    });
    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({ template: "old", business: { businessName: "X", faqKnowledgeBase: "y" } }),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("programmatic config");
    expect(res._json.details).toContain("Save as Template");
  });
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe("createFromTemplateHandler — happy path", () => {
  it("instantiates an agent with overridden businessName and faq", async () => {
    mockLoadTemplate.mockResolvedValue({
      _id: "x",
      name: "plumber",
      type: "template",
      formData: {},
      exportConfig: makeTemplateExportConfig(),
    });

    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({
        template: "plumber",
        business: {
          businessName: "Acme Plumbing Co",
          faqKnowledgeBase: "## New Acme FAQ",
        },
      }),
      res,
    );

    expect(res._status).toBe(201);
    expect(res._json.success).toBe(true);
    expect(res._json.template).toBe("plumber");
    expect(res._json.slug).toBe("acme-plumbing-co");
    expect(res._json.agent_id).toBe("agent_test");
    expect(res._json.conversation_flow_id).toBe("cf_test");

    // The generator must have received the overridden values.
    const generateCall = mockGenerateAgent.mock.calls[0];
    const agentConfigArg = generateCall[0];
    expect(agentConfigArg.businessName).toBe("Acme Plumbing Co");
    expect(agentConfigArg.faqKnowledgeBase).toBe("## New Acme FAQ");

    // persistClient called with the new slug
    expect(mockPersistClient).toHaveBeenCalledWith("acme-plumbing-co", expect.any(Object));
  });

  it("respects an explicit client.slug override", async () => {
    mockLoadTemplate.mockResolvedValue({
      _id: "x",
      name: "plumber",
      type: "template",
      formData: {},
      exportConfig: makeTemplateExportConfig(),
    });

    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({
        template: "plumber",
        business: { businessName: "Acme Plumbing", faqKnowledgeBase: "x" },
        client: { slug: "acme-custom" },
      }),
      res,
    );

    expect(res._status).toBe(201);
    expect(res._json.slug).toBe("acme-custom");
    expect(mockPersistClient).toHaveBeenCalledWith("acme-custom", expect.any(Object));
  });

  it("auto-increments slug when one collision exists", async () => {
    mockLoadTemplate.mockResolvedValue({
      _id: "x",
      name: "plumber",
      type: "template",
      formData: {},
      exportConfig: makeTemplateExportConfig(),
    });
    mockNotificationClients["acme-plumbing"] = { name: "Already there" };

    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({
        template: "plumber",
        business: { businessName: "Acme Plumbing", faqKnowledgeBase: "x" },
      }),
      res,
    );

    expect(res._status).toBe(201);
    expect(res._json.slug).toBe("acme-plumbing-2");
    expect(mockPersistClient).toHaveBeenCalledWith("acme-plumbing-2", expect.any(Object));
  });

  it("auto-increments slug across multiple collisions", async () => {
    mockLoadTemplate.mockResolvedValue({
      _id: "x",
      name: "plumber",
      type: "template",
      formData: {},
      exportConfig: makeTemplateExportConfig(),
    });
    mockNotificationClients["acme-plumbing"] = {};
    mockNotificationClients["acme-plumbing-2"] = {};
    mockNotificationClients["acme-plumbing-3"] = {};

    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({
        template: "plumber",
        business: { businessName: "Acme Plumbing", faqKnowledgeBase: "x" },
      }),
      res,
    );

    expect(res._status).toBe(201);
    expect(res._json.slug).toBe("acme-plumbing-4");
    expect(mockPersistClient).toHaveBeenCalledWith("acme-plumbing-4", expect.any(Object));
  });

  it("uses overridden client.dispatch_text_numbers from the request", async () => {
    mockLoadTemplate.mockResolvedValue({
      _id: "x",
      name: "plumber",
      type: "template",
      formData: {},
      exportConfig: makeTemplateExportConfig(),
    });

    const res = mockRes();
    await createFromTemplateHandler(
      mockReq({
        template: "plumber",
        business: { businessName: "Acme", faqKnowledgeBase: "x" },
        client: { dispatch_text_numbers: ["+19998887777"] },
      }),
      res,
    );

    expect(res._status).toBe(201);
    // deriveNotificationConfig is called with the merged client config
    const deriveCall = mockDeriveNotificationConfig.mock.calls[0];
    expect(deriveCall[1].dispatch_text_numbers).toEqual(["+19998887777"]);
  });
});
