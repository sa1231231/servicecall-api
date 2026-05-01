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
  mockToLabel,
  mockExtractFlowParams,
  mockExtractAgentParams,
  mockPersistClient,
  mockUpdateClientField,
  mockLogPhoneEvent,
  mockGetSettings,
  mockNotificationClients,
} = vi.hoisted(() => ({
  mockFlowCreate: vi.fn(),
  mockAgentCreate: vi.fn(),
  mockFlowDelete: vi.fn(),
  mockProvisionPhoneNumber: vi.fn(),
  mockGetDataPointDefaults: vi.fn(),
  mockGenerateAgent: vi.fn(),
  mockDeriveNotificationConfig: vi.fn(),
  mockDeriveMultiPathNotificationConfig: vi.fn(),
  mockToLabel: vi.fn() as any,
  mockExtractFlowParams: vi.fn() as any,
  mockExtractAgentParams: vi.fn() as any,
  mockPersistClient: vi.fn(),
  mockUpdateClientField: vi.fn(),
  mockLogPhoneEvent: vi.fn(),
  mockGetSettings: vi.fn(),
  mockNotificationClients: {} as Record<string, any>,
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
  updateClientField: (...a: any[]) => mockUpdateClientField(...a),
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

vi.mock("../../../lib/notification-config.js", () => ({
  toLabel: (...a: any[]) => mockToLabel(...a),
  deriveNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
  deriveMultiPathNotificationConfig: (...a: any[]) => mockDeriveMultiPathNotificationConfig(...a),
}));

vi.mock("../../../lib/retell-sync.js", () => ({
  extractFlowParams: (...a: any[]) => mockExtractFlowParams(...a),
  extractAgentParams: (...a: any[]) => mockExtractAgentParams(...a),
}));

// Dynamic imports inside the handler — mock these too.
vi.mock("../../../lib/phone-number-history.js", () => ({
  logPhoneEvent: (...a: any[]) => mockLogPhoneEvent(...a),
}));

vi.mock("../../../lib/settings.js", () => ({
  getSettings: (...a: any[]) => mockGetSettings(...a),
}));

const { createAgentHandler } = await import("../create-agent.js");

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

function makeBody(overrides: Record<string, any> = {}) {
  const { business, client, ...rest } = overrides;
  return {
    business: {
      businessName: "Test Co",
      faqKnowledgeBase: "FAQ here",
      ...business,
    },
    dataPoints: [
      { variableName: "full_name", label: "Name", type: "string" },
    ],
    client: {
      slug: "test-co",
      dispatch_text_numbers: ["+15550001111"],
      dispatch_email: ["dispatch@test.com"],
      ...client,
    },
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults: success path
  mockFlowCreate.mockResolvedValue({ conversation_flow_id: "cf_test" });
  mockAgentCreate.mockResolvedValue({ agent_id: "agent_test" });
  mockGetDataPointDefaults.mockResolvedValue({});
  mockGenerateAgent.mockReturnValue({
    agent: { conversationFlow: {}, agent_name: "Test Co" },
    resolved: [{ variableName: "full_name", label: "Name" }],
    resolvedPaths: undefined,
  });
  mockDeriveNotificationConfig.mockReturnValue({
    name: "Test Co",
    agent_id: "agent_test",
    dispatch_text_numbers: ["+15550001111"],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: ["dispatch@test.com"],
    dispatch_cc: null,
    message_types: {},
    default_message_type: "default",
  });
  mockDeriveMultiPathNotificationConfig.mockReturnValue({
    name: "Test Co",
    agent_id: "agent_test",
    dispatch_text_numbers: ["+15550001111"],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: ["dispatch@test.com"],
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

  for (const k of Object.keys(mockNotificationClients)) delete mockNotificationClients[k];
});

// ── Validation ─────────────────────────────────────────────────────────────

describe("createAgentHandler — validation", () => {
  it("400 when missing business.businessName", async () => {
    const res = mockRes();
    const body = makeBody();
    delete body.business.businessName;
    await createAgentHandler(mockReq(body), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("businessName");
  });

  it("400 when missing business.faqKnowledgeBase", async () => {
    const res = mockRes();
    const body = makeBody();
    delete body.business.faqKnowledgeBase;
    await createAgentHandler(mockReq(body), res);
    expect(res._status).toBe(400);
  });

  it("400 when neither dataPoints nor paths provided", async () => {
    const res = mockRes();
    const body = makeBody({ dataPoints: undefined });
    await createAgentHandler(mockReq(body), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("dataPoints");
  });

  it("400 when paths[i].name missing", async () => {
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [{ name: "", transitionCondition: "x", dataPoints: [{ variableName: "x" }] }],
      })),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("paths[0].name");
  });

  it("400 when paths[i].transitionCondition missing", async () => {
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [{ name: "p", transitionCondition: "", dataPoints: [{ variableName: "x" }] }],
      })),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("transitionCondition");
  });

  it("400 when paths[i].dataPoints not an array", async () => {
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [{ name: "p", transitionCondition: "c", dataPoints: "not-an-array" as any }],
      })),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("dataPoints");
  });

  it("accepts paths[i].dataPoints empty (immediate callback path)", async () => {
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [{ name: "p", transitionCondition: "c", dataPoints: [] }],
      })),
      res,
    );
    expect(res._status).toBe(201);
  });

  it("400 when paths[i].end_mode invalid", async () => {
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [{ name: "p", transitionCondition: "c", dataPoints: [{ variableName: "x" }], end_mode: "bogus" }],
      })),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("end_mode");
  });

  it("400 when paths[i].end_mode is transfer but no dispatch call number", async () => {
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [{ name: "p", transitionCondition: "c", dataPoints: [{ variableName: "x" }], end_mode: "transfer" }],
        client: { slug: "x", dispatch_text_numbers: ["+15550001111"], dispatch_call_number: null },
      })),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("transfer");
  });

  it("400 when client.slug missing", async () => {
    const res = mockRes();
    const body = makeBody();
    delete body.client.slug;
    await createAgentHandler(mockReq(body), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("slug");
  });

  it("falls back to owner_phone when dispatch_text_numbers is empty", async () => {
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        client: { slug: "test", dispatch_text_numbers: [] },
      })),
      res,
    );

    expect(res._status).toBe(201);
    expect(mockGetSettings).toHaveBeenCalled();
    // The persisted entry should have the owner phone as dispatch
    const config = mockDeriveNotificationConfig.mock.calls[0][1];
    expect(config.dispatch_text_numbers).toEqual(["+13017872841"]);
  });

  it("400 when dispatch_text_numbers is empty AND owner_phone is unset", async () => {
    mockGetSettings.mockResolvedValue({ owner_phone: "" });
    const res = mockRes();
    await createAgentHandler(
      mockReq(makeBody({
        client: { slug: "test", dispatch_text_numbers: [] },
      })),
      res,
    );
    expect(res._status).toBe(400);
    expect(res._json.error).toContain("owner phone");
  });

  it("409 when slug already exists in notificationClients", async () => {
    mockNotificationClients["test-co"] = { name: "Existing" };
    const res = mockRes();
    await createAgentHandler(mockReq(makeBody()), res);
    expect(res._status).toBe(409);
    expect(res._json.error).toContain("already exists");
  });
});

// ── Success path + new field passthrough ──────────────────────────────────

describe("createAgentHandler — success path", () => {
  it("creates flow, agent, persists client, provisions number → 201", async () => {
    const res = mockRes();
    await createAgentHandler(mockReq(makeBody()), res);

    expect(res._status).toBe(201);
    expect(mockFlowCreate).toHaveBeenCalledTimes(1);
    expect(mockAgentCreate).toHaveBeenCalledTimes(1);
    expect(mockPersistClient).toHaveBeenCalledTimes(1);
    expect(mockProvisionPhoneNumber).toHaveBeenCalledTimes(1);
    expect(res._json.success).toBe(true);
    expect(res._json.agent_id).toBe("agent_test");
    expect(res._json.conversation_flow_id).toBe("cf_test");
    expect(res._json.provisioned_number).toBe("+15559998888");
  });

  it("logs the phone-history provisioning event", async () => {
    await createAgentHandler(mockReq(makeBody()), mockRes());

    expect(mockLogPhoneEvent).toHaveBeenCalledWith(
      "test-co",
      "+15559998888",
      "PN_test",
      "provisioned",
    );
  });

  it("provision failure does not fail the request — provision_error is reported", async () => {
    mockProvisionPhoneNumber.mockRejectedValue(new Error("no numbers available"));
    const res = mockRes();

    await createAgentHandler(mockReq(makeBody()), res);

    expect(res._status).toBe(201);
    expect(res._json.provisioned_number).toBeNull();
    expect(res._json.provision_error).toContain("no numbers available");
    expect(mockLogPhoneEvent).not.toHaveBeenCalled();
  });

  it("persists dispatch_call_overrides on jsonEntry", async () => {
    const overrides = { "+15550001111": "+15558888888" };
    await createAgentHandler(
      mockReq(makeBody({
        client: {
          slug: "test-co",
          dispatch_text_numbers: ["+15550001111"],
          dispatch_call_overrides: overrides,
        },
      })),
      mockRes(),
    );

    const persistedEntry = mockPersistClient.mock.calls[0][1];
    expect(persistedEntry.dispatch_call_overrides).toEqual(overrides);
  });

  it("persists webhook_url on jsonEntry", async () => {
    await createAgentHandler(
      mockReq(makeBody({
        client: {
          slug: "test-co",
          dispatch_text_numbers: ["+15550001111"],
          webhook_url: "https://hook.example.com/x",
        },
      })),
      mockRes(),
    );

    expect(mockPersistClient.mock.calls[0][1].webhook_url).toBe("https://hook.example.com/x");
  });

  it("persists notification_greeting on jsonEntry", async () => {
    await createAgentHandler(
      mockReq(makeBody({
        client: {
          slug: "test-co",
          dispatch_text_numbers: ["+15550001111"],
          notification_greeting: "Hi from Acme",
        },
      })),
      mockRes(),
    );

    expect(mockPersistClient.mock.calls[0][1].notification_greeting).toBe("Hi from Acme");
  });

  it("persists weekly_report_enabled=true on jsonEntry", async () => {
    await createAgentHandler(
      mockReq(makeBody({
        client: {
          slug: "test-co",
          dispatch_text_numbers: ["+15550001111"],
          weekly_report_enabled: true,
        },
      })),
      mockRes(),
    );

    expect(mockPersistClient.mock.calls[0][1].weekly_report_enabled).toBe(true);
  });

  it("persists weekly_report_enabled=false on jsonEntry (boolean check, not truthy)", async () => {
    await createAgentHandler(
      mockReq(makeBody({
        client: {
          slug: "test-co",
          dispatch_text_numbers: ["+15550001111"],
          weekly_report_enabled: false,
        },
      })),
      mockRes(),
    );

    expect(mockPersistClient.mock.calls[0][1].weekly_report_enabled).toBe(false);
  });

  it("does NOT persist new fields when not in body", async () => {
    await createAgentHandler(mockReq(makeBody()), mockRes());

    const persistedEntry = mockPersistClient.mock.calls[0][1];
    expect(persistedEntry).not.toHaveProperty("dispatch_call_overrides");
    expect(persistedEntry).not.toHaveProperty("webhook_url");
    expect(persistedEntry).not.toHaveProperty("notification_greeting");
    expect(persistedEntry).not.toHaveProperty("weekly_report_enabled");
  });

  it("persists dispatch_by_type when provided", async () => {
    const byType = { emergency: { dispatch_text_numbers: ["+15558888888"] } };
    await createAgentHandler(
      mockReq(makeBody({
        client: {
          slug: "test-co",
          dispatch_text_numbers: ["+15550001111"],
          dispatch_by_type: byType,
        },
      })),
      mockRes(),
    );

    expect(mockPersistClient.mock.calls[0][1].dispatch_by_type).toEqual(byType);
  });

  it("multi-path: persists path_end_modes for transfer paths only", async () => {
    mockGenerateAgent.mockReturnValue({
      agent: { conversationFlow: {} },
      resolved: [],
      resolvedPaths: [
        { name: "p1", resolved: [] },
        { name: "p2", resolved: [] },
      ],
    });

    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [
          { name: "p1", transitionCondition: "c1", dataPoints: [{ variableName: "x" }], end_mode: "callback" },
          { name: "p2", transitionCondition: "c2", dataPoints: [{ variableName: "y" }], end_mode: "transfer" },
        ],
        client: {
          slug: "test-co",
          dispatch_text_numbers: ["+15550001111"],
          dispatch_call_number: "+15559998888",
        },
      })),
      mockRes(),
    );

    const persistedEntry = mockPersistClient.mock.calls[0][1];
    expect(persistedEntry.path_end_modes).toEqual({ p2: "transfer" });
  });

  it("does not set path_end_modes when no paths use transfer", async () => {
    mockGenerateAgent.mockReturnValue({
      agent: { conversationFlow: {} },
      resolved: [],
      resolvedPaths: [{ name: "p1", resolved: [] }],
    });

    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [
          { name: "p1", transitionCondition: "c1", dataPoints: [{ variableName: "x" }], end_mode: "callback" },
        ],
      })),
      mockRes(),
    );

    expect(mockPersistClient.mock.calls[0][1]).not.toHaveProperty("path_end_modes");
  });

  it("uses multi-path notification config when resolvedPaths.length > 1", async () => {
    mockGenerateAgent.mockReturnValue({
      agent: { conversationFlow: {} },
      resolved: [],
      resolvedPaths: [
        { name: "p1", resolved: [] },
        { name: "p2", resolved: [] },
      ],
    });

    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [
          { name: "p1", transitionCondition: "c1", dataPoints: [{ variableName: "x" }] },
          { name: "p2", transitionCondition: "c2", dataPoints: [{ variableName: "y" }] },
        ],
      })),
      mockRes(),
    );

    expect(mockDeriveMultiPathNotificationConfig).toHaveBeenCalled();
    expect(mockDeriveNotificationConfig).not.toHaveBeenCalled();
  });

  it("uses single-path notification config when only one resolvedPath", async () => {
    mockGenerateAgent.mockReturnValue({
      agent: { conversationFlow: {} },
      resolved: [],
      resolvedPaths: [{ name: "p1", resolved: [] }],
    });

    await createAgentHandler(
      mockReq(makeBody({
        dataPoints: undefined,
        paths: [{ name: "p1", transitionCondition: "c", dataPoints: [{ variableName: "x" }] }],
      })),
      mockRes(),
    );

    expect(mockDeriveNotificationConfig).toHaveBeenCalled();
    expect(mockDeriveMultiPathNotificationConfig).not.toHaveBeenCalled();
  });
});

// ── Closing prompt + Live Transfer Recovery passthrough ───────────────────
// These cover lines 165-169 of create-agent.ts (the agentConfig builder).
// Without explicit closing prompts, the .trim() chains short-circuit and v8
// records them as uncovered.

describe("createAgentHandler — agentConfig closing prompts", () => {
  it("forwards closePrompt, closingRemarksPrompt, closingStatementText to generateAgent", async () => {
    await createAgentHandler(
      mockReq(makeBody({
        business: {
          businessName: "Test Co",
          faqKnowledgeBase: "FAQ",
          closePrompt: "  Close prompt with whitespace  ",
          closingRemarksPrompt: "Remarks prompt",
          closingStatementText: "Statement text",
        },
      })),
      mockRes(),
    );

    const agentConfig = mockGenerateAgent.mock.calls[0][0];
    // Trim-then-fallback should strip the whitespace
    expect(agentConfig.closePrompt).toBe("Close prompt with whitespace");
    expect(agentConfig.closingRemarksPrompt).toBe("Remarks prompt");
    expect(agentConfig.closingStatementText).toBe("Statement text");
  });

  it("forwards liveTransferRecoveryPrompt to generateAgent (new in 5c59d31)", async () => {
    await createAgentHandler(
      mockReq(makeBody({
        business: {
          businessName: "Test Co",
          faqKnowledgeBase: "FAQ",
          liveTransferRecoveryPrompt: "Custom recovery for {{business_name}}",
        },
      })),
      mockRes(),
    );

    const agentConfig = mockGenerateAgent.mock.calls[0][0];
    expect(agentConfig.liveTransferRecoveryPrompt).toBe("Custom recovery for {{business_name}}");
  });

  it("normalizes empty/whitespace-only closing prompts to undefined", async () => {
    await createAgentHandler(
      mockReq(makeBody({
        business: {
          businessName: "Test Co",
          faqKnowledgeBase: "FAQ",
          closePrompt: "",
          closingRemarksPrompt: "   ",
          closingStatementText: "\n\t",
          liveTransferRecoveryPrompt: "",
        },
      })),
      mockRes(),
    );

    const agentConfig = mockGenerateAgent.mock.calls[0][0];
    expect(agentConfig.closePrompt).toBeUndefined();
    expect(agentConfig.closingRemarksPrompt).toBeUndefined();
    expect(agentConfig.closingStatementText).toBeUndefined();
    expect(agentConfig.liveTransferRecoveryPrompt).toBeUndefined();
  });

  it("leaves closing prompts undefined when not provided in body.business", async () => {
    await createAgentHandler(mockReq(makeBody()), mockRes());

    const agentConfig = mockGenerateAgent.mock.calls[0][0];
    expect(agentConfig.closePrompt).toBeUndefined();
    expect(agentConfig.closingRemarksPrompt).toBeUndefined();
    expect(agentConfig.closingStatementText).toBeUndefined();
    expect(agentConfig.liveTransferRecoveryPrompt).toBeUndefined();
  });
});

// ── Error handling ─────────────────────────────────────────────────────────

describe("createAgentHandler — error handling", () => {
  it("502 when Retell agent creation fails", async () => {
    mockAgentCreate.mockRejectedValue(new Error("retell down"));
    const res = mockRes();

    await createAgentHandler(mockReq(makeBody()), res);

    expect(res._status).toBe(502);
    expect(res._json.error).toContain("Retell");
  });

  it("400 when generation fails with validation-flavored error", async () => {
    mockGenerateAgent.mockImplementation(() => {
      throw new Error("Unknown data point: bogus_key");
    });
    const res = mockRes();

    await createAgentHandler(mockReq(makeBody()), res);

    expect(res._status).toBe(400);
    expect(res._json.error).toContain("generation");
  });

  it("cleans up the conversation flow when agent creation fails", async () => {
    mockAgentCreate.mockRejectedValue(new Error("agent fail"));

    await createAgentHandler(mockReq(makeBody()), mockRes());

    expect(mockFlowDelete).toHaveBeenCalledWith("cf_test");
  });

  it("does not attempt cleanup when flow creation itself failed", async () => {
    mockFlowCreate.mockRejectedValue(new Error("flow fail"));

    await createAgentHandler(mockReq(makeBody()), mockRes());

    expect(mockFlowDelete).not.toHaveBeenCalled();
  });

  it("swallows cleanup errors when flow.delete throws after agent.create fails", async () => {
    mockAgentCreate.mockRejectedValue(new Error("agent fail"));
    mockFlowDelete.mockRejectedValue(new Error("flow delete fail"));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = mockRes();

    await createAgentHandler(mockReq(makeBody()), res);

    // Original 502 still returned despite cleanup error
    expect(res._status).toBe(502);
    expect(errSpy).toHaveBeenCalledWith(
      "[create-agent] cleanup failed:",
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("appends HTTP status from Retell SDK error to details", async () => {
    const retellErr: any = new Error("rate limited");
    retellErr.status = 429;
    mockAgentCreate.mockRejectedValue(retellErr);

    const res = mockRes();
    await createAgentHandler(mockReq(makeBody()), res);

    expect(res._status).toBe(502);
    expect(res._json.details).toContain("(HTTP 429)");
  });

  it("uses Retell SDK error.error.message when present (overrides plain message)", async () => {
    const retellErr: any = new Error("outer message");
    retellErr.error = { message: "specific Retell error" };
    mockAgentCreate.mockRejectedValue(retellErr);

    const res = mockRes();
    await createAgentHandler(mockReq(makeBody()), res);

    expect(res._status).toBe(502);
    expect(res._json.details).toBe("specific Retell error");
  });
});

// ── Composite data point flattening ───────────────────────────────────────

describe("createAgentHandler — flattenDataPoints (composite)", () => {
  it("expands composite data points to their child variables in jsonEntry retell_agents map", async () => {
    // Set up a resolved data point that's marked composite with sub-variables
    mockGenerateAgent.mockReturnValue({
      agent: { conversationFlow: {}, agent_name: "Test Co" },
      resolved: [
        {
          variableName: "address",
          label: "Address",
          composite: true,
          variables: [
            { variableName: "street_address", label: "Street" },
            { variableName: "city", label: "City" },
          ],
        },
      ],
      resolvedPaths: undefined,
    });

    await createAgentHandler(mockReq(makeBody()), mockRes());

    // The composite data point's child variables are passed to deriveNotificationConfig
    // (single-path mode in this test). Verify flattenDataPoints expanded them.
    const variables = mockDeriveNotificationConfig.mock.calls[0][0];
    const keys = variables.map((v: any) => v.key);
    expect(keys).toContain("street_address");
    expect(keys).toContain("city");
    // The composite parent itself should NOT be in the flat list
    expect(keys).not.toContain("address");
  });
});
