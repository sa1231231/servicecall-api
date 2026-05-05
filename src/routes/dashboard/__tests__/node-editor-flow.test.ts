import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { makeRes, makeReq, makeDoc, runRoute as runRouteHelper } from "./node-editor-helpers.js";

const {
  mockGetClientDocument, mockLoadClientsFromDb, mockGetDb, mockUpdateOne,
  mockFetchRetellAgent, mockExtractVariables,
  mockParseConversationFlow, mockValidateConversationFlow,
  mockCreateVersionSnapshot, mockLogAudit,
  mockDeriveNotificationConfig,
  mockGetDataPointDefaults, mockResolveDataPoints,
  mockRegenerateDataChain, mockApplyRegeneratedChain,
  mockPushFlowToRetell, mockGetWarmTransferAgentVersion,
  mockBuildWarmTransferOption, mockRenderTemplate,
} = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
  mockLoadClientsFromDb: vi.fn(),
  mockGetDb: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockFetchRetellAgent: vi.fn(),
  mockExtractVariables: vi.fn(),
  mockParseConversationFlow: vi.fn(),
  mockValidateConversationFlow: vi.fn(),
  mockCreateVersionSnapshot: vi.fn(),
  mockLogAudit: vi.fn(),
  mockDeriveNotificationConfig: vi.fn(),
  mockGetDataPointDefaults: vi.fn(),
  mockResolveDataPoints: vi.fn(),
  mockRegenerateDataChain: vi.fn(),
  mockApplyRegeneratedChain: vi.fn(),
  mockPushFlowToRetell: vi.fn(),
  mockGetWarmTransferAgentVersion: vi.fn(),
  mockBuildWarmTransferOption: vi.fn(),
  mockRenderTemplate: vi.fn(),
}));

vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key" } }));
vi.mock("retell-sdk", () => ({
  default: class { conversationFlow = { update: vi.fn() }; agent = { update: vi.fn() }; },
}));
vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
  loadClientsFromDb: (...a: any[]) => mockLoadClientsFromDb(...a),
}));
vi.mock("../../../lib/db.js", () => ({ getDb: (...a: any[]) => mockGetDb(...a) }));
vi.mock("../../../lib/retell-sync.js", () => ({
  fetchRetellAgent: (...a: any[]) => mockFetchRetellAgent(...a),
  pushFlowToRetell: (...a: any[]) => mockPushFlowToRetell(...a),
  extractVariables: (...a: any[]) => mockExtractVariables(...a),
}));
vi.mock("../../../lib/node-parser.js", () => ({
  parseConversationFlow: (...a: any[]) => mockParseConversationFlow(...a),
}));
vi.mock("../../../lib/node-validator.js", () => ({
  validateConversationFlow: (...a: any[]) => mockValidateConversationFlow(...a),
}));
vi.mock("../../../lib/agent-versions.js", () => ({
  createVersionSnapshot: (...a: any[]) => mockCreateVersionSnapshot(...a),
  getVersion: vi.fn(), listVersions: vi.fn(), getLatestVersion: vi.fn(),
}));
vi.mock("../../../lib/audit.js", () => ({ logAudit: (...a: any[]) => mockLogAudit(...a) }));
vi.mock("../../../lib/notification-config.js", () => ({
  deriveNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
}));
vi.mock("../../../middleware/require-role.js", () => ({
  requireRoot: (req: Request, res: Response, next: NextFunction) => next(),
}));
vi.mock("../../../lib/node-regenerator.js", () => ({
  regenerateDataChain: (...a: any[]) => mockRegenerateDataChain(...a),
  applyRegeneratedChain: (...a: any[]) => mockApplyRegeneratedChain(...a),
}));
vi.mock("../../../lib/data-point-defaults.js", () => ({
  getDataPointDefaults: (...a: any[]) => mockGetDataPointDefaults(...a),
}));
vi.mock("../../../lib/agent-generator/generate-agent.js", () => ({
  resolveDataPoints: (...a: any[]) => mockResolveDataPoints(...a),
}));
vi.mock("../../../lib/agent-generator/data-point-registry.js", () => ({ PATH_TAKEN_VAR: "path_taken" }));
vi.mock("../../../lib/agent-generator/node-builders.js", () => ({
  makeIdFactory: vi.fn(), buildTransitionNode: vi.fn(),
  buildDataChain: vi.fn(),
  buildWarmTransferOption: (...a: any[]) => mockBuildWarmTransferOption(...a),
  DEFAULT_LIVE_TRANSFER_RECOVERY_PROMPT: "fallback prompt",
}));
vi.mock("../../../lib/agent-generator/warm-transfer-agent-version.js", () => ({
  getWarmTransferAgentVersion: (...a: any[]) => mockGetWarmTransferAgentVersion(...a),
}));
vi.mock("../../../lib/build-notification.js", () => ({
  renderTemplate: (...a: any[]) => mockRenderTemplate(...a),
}));

const { nodeEditorRouter } = await import("../node-editor.js");

const runRoute = (method: string, path: string, req: Request, res: Response) =>
  runRouteHelper(nodeEditorRouter, method, path, req, res);

beforeEach(() => {
  for (const m of [
    mockGetClientDocument, mockLoadClientsFromDb, mockGetDb, mockUpdateOne,
    mockFetchRetellAgent, mockExtractVariables, mockParseConversationFlow,
    mockValidateConversationFlow, mockCreateVersionSnapshot, mockLogAudit,
    mockDeriveNotificationConfig, mockGetDataPointDefaults, mockResolveDataPoints,
    mockRegenerateDataChain, mockApplyRegeneratedChain, mockPushFlowToRetell,
    mockGetWarmTransferAgentVersion, mockBuildWarmTransferOption, mockRenderTemplate,
  ]) m.mockReset();

  mockUpdateOne.mockResolvedValue({});
  mockGetDb.mockReturnValue({ collection: () => ({ updateOne: mockUpdateOne }) });
  mockLoadClientsFromDb.mockResolvedValue(undefined);
  mockExtractVariables.mockReturnValue([]);
  mockDeriveNotificationConfig.mockReturnValue({ message_types: {}, default_message_type: null });
  mockValidateConversationFlow.mockReturnValue([]);
  mockCreateVersionSnapshot.mockResolvedValue({});
  mockLogAudit.mockResolvedValue({});
  mockGetDataPointDefaults.mockResolvedValue({});
  mockRegenerateDataChain.mockReturnValue({});
  mockPushFlowToRetell.mockResolvedValue(undefined);
  mockGetWarmTransferAgentVersion.mockResolvedValue("v1");
  mockBuildWarmTransferOption.mockReturnValue({ kind: "warm" });
  mockRenderTemplate.mockImplementation((tpl: string) => tpl);
});

// ── edit-branch-condition ──────────────────────────────────────────────────

describe("POST /:agentId/edit-branch-condition", () => {
  it("returns 400 when variableName missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-branch-condition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { branchConditions: [] } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when branchConditions is neither null nor an array", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-branch-condition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableName: "x", branchConditions: "wat" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when variable not in path", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{
        name: "Default",
        dataChain: [{ variableName: "full_name", label: "Name", variableDefs: [{ name: "full_name", type: "string" }], collectNode: { id: "c1", name: "Collect Name" }, confirmNode: { id: "cf1" }, conversationPrompt: "", forwardCondition: "" }],
      }],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-branch-condition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableName: "missing", branchConditions: null } }), res);
    expect(res._status).toBe(404);
  });

  it("removes branch condition when null and audits", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{
        name: "Default",
        dataChain: [{ variableName: "full_name", label: "Name", variableDefs: [{ name: "full_name", type: "string" }], collectNode: { id: "c1", name: "Collect Name" }, confirmNode: { id: "cf1" }, conversationPrompt: "", forwardCondition: "" }],
      }],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-branch-condition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableName: "full_name", branchConditions: null } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, variableName: "full_name", pathName: "Default" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "edit_branch_condition", "acme/agent_1",
      { variableName: "full_name", pathName: "Default", branchConditions: null },
    );
  });

  it("sets branch conditions when array provided", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{
        name: "Default",
        dataChain: [{ variableName: "email", label: "Email", variableDefs: [{ name: "email", type: "string" }], collectNode: { id: "c1", name: "Collect Email" }, confirmNode: { id: "cf1" }, conversationPrompt: "", forwardCondition: "" }],
      }],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-branch-condition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: {
        variableName: "email",
        branchConditions: [{ variable: "intent", operator: "==", value: "leadgen" }],
      }}), res);
    expect(res._status).toBe(200);
  });
});

// ── edit-path-name ─────────────────────────────────────────────────────────

describe("POST /:agentId/edit-path-name", () => {
  it("returns 400 when oldName or newName missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-name",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { oldName: "Old" } }), res);
    expect(res._status).toBe(400);
  });

  it("short-circuits to success when oldName === newName", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-name",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { oldName: "Same", newName: "Same" } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, pathName: "Same" });
    // No DB write should happen
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("returns 404 when path not found", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [] } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({ paths: [{ name: "Other" }] });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-name",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { oldName: "Sales", newName: "Leads" } }), res);
    expect(res._status).toBe(404);
  });

  it("renames nodes, message_types, default_message_type, dispatch_by_type, path_end_modes, and audits", async () => {
    const doc = makeDoc({
      message_types: { Sales: { label: "Sales", fields: [] } },
      default_message_type: "Sales",
      dispatch_by_type: { Sales: { dispatch_call_number: "+1" } },
      path_end_modes: { Sales: "transfer" },
    });
    mockGetClientDocument.mockResolvedValue(doc);
    const nodes = [
      { id: "fe-Sales", name: "Front Extract (Sales)", variables: [{ name: "_path_taken", description: 'Always set to "Sales".' }] },
      { id: "p-Sales", name: "Prompt (Sales)" },
      { id: "pt", name: "Pre-Transfer (Sales)" },
      { id: "tc", name: "Transfer Call (Sales)" },
    ];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Sales", frontExtractNode: { id: "fe-Sales" } }],
    });

    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-name",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { oldName: "Sales", newName: "Leads" } }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, pathName: "Leads" });
    expect(nodes[0].name).toBe("Front Extract (Leads)");
    expect((nodes[0].variables as any[])[0].description).toBe('Always set to "Leads".');
    expect(nodes[1].name).toBe("Prompt (Leads)");
    expect(nodes[2].name).toBe("Pre-Transfer (Leads)");
    expect(nodes[3].name).toBe("Transfer Call (Leads)");

    const updateCall = mockUpdateOne.mock.calls[0];
    const updates = updateCall[1].$set;
    expect(updates.message_types).toHaveProperty("Leads");
    expect(updates.message_types).not.toHaveProperty("Sales");
    expect(updates.default_message_type).toBe("Leads");
    expect(updates.dispatch_by_type).toHaveProperty("Leads");
    expect(updates.path_end_modes).toHaveProperty("Leads");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "edit_path_name", "acme/agent_1",
      { oldName: "Sales", newName: "Leads" },
    );
  });
});

// ── edit-human-request-mode ────────────────────────────────────────────────

describe("POST /:agentId/edit-human-request-mode", () => {
  it("returns 400 when mode not callback/live_transfer", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-human-request-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { mode: "weird" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-human-request-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { mode: "callback" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 500 when Human Request node missing", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [{ name: "Other" }] } },
      conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({ paths: [] });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-human-request-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { mode: "callback" } }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/Human Request/);
  });

  it("switches to callback: removes Transfer Call node, sets callback edge", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const nodes: any[] = [
      { id: "hr", name: "Human Request" },
      { id: "tc", name: "Transfer Call" },
      { id: "ltr", name: "Live Transfer Recovery" },
      { id: "ph", name: "Polite Hangup" },
    ];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({ paths: [] });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-human-request-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { mode: "callback" } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, mode: "callback" });
    expect(nodes.find((n: any) => n.name === "Transfer Call")).toBeUndefined();
    expect(nodes.find((n: any) => n.name === "Live Transfer Recovery")).toBeUndefined();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "edit_human_request_mode", "acme/agent_1", { mode: "callback" },
    );
  });

  it("switches to live_transfer: adds Transfer Call + Live Transfer Recovery", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const nodes: any[] = [
      { id: "hr", name: "Human Request", display_position: { x: 0, y: 0 } },
      { id: "cr", name: "Closing Remarks" },
      { id: "ph", name: "Polite Hangup" },
    ];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({ paths: [] });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-human-request-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { mode: "live_transfer" } }), res);
    expect(res._status).toBe(200);
    expect(nodes.find((n: any) => n.name === "Transfer Call")).toBeDefined();
    expect(nodes.find((n: any) => n.name === "Live Transfer Recovery")).toBeDefined();
    expect(mockBuildWarmTransferOption).toHaveBeenCalledWith("v1");
  });

  it("migrates legacy 'Transfer Failed' name to 'Live Transfer Recovery'", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const nodes: any[] = [
      { id: "hr", name: "Human Request", display_position: { x: 0, y: 0 } },
      { id: "tf", name: "Transfer Failed" },
    ];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({ paths: [] });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-human-request-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { mode: "live_transfer" } }), res);
    expect(res._status).toBe(200);
    // Legacy node should be migrated
    expect(nodes.find((n: any) => n.name === "Transfer Failed")).toBeUndefined();
    expect(nodes.find((n: any) => n.name === "Live Transfer Recovery")).toBeDefined();
  });
});

// ── edit-path-end-mode ─────────────────────────────────────────────────────

describe("POST /:agentId/edit-path-end-mode", () => {
  it("returns 400 when pathName missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { mode: "callback" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when mode not callback/transfer", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "x" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "callback" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 for transfer mode when no dispatch number is configured", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ dispatch_call_number: null }));
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "transfer" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/no dispatch call number/);
  });

  it("returns 404 when path not found in flow", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ dispatch_call_number: "+15555" }));
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [] } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({ paths: [{ name: "Other" }], closeNode: { id: "close" } });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "transfer" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 500 when router node missing", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ dispatch_call_number: "+15555" }));
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [{ id: "other", name: "Other" }] } },
      conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Sales", routerNode: { id: "router-missing" } }],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "transfer" } }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/Variables Router/);
  });

  it("switches a multi-path callback toggle creates a per-path Close, pushes flow, persists path_end_modes, audits", async () => {
    const doc = makeDoc({
      dispatch_call_number: "+15555",
      path_end_modes: { Sales: "transfer", Other: "transfer" },
    });
    mockGetClientDocument.mockResolvedValue(doc);
    const router = { id: "router-Sales", else_edge: { destination_node_id: "old" } };
    const nodes: any[] = [
      router,
      { id: "close", name: "Close", instruction: { type: "prompt", text: "shared close" }, always_edge: { destination_node_id: "cr", id: "ae-1", transition_condition: { type: "prompt", prompt: "Always" } } },
      { id: "pt-Sales", name: "Pre-Transfer (Sales)" },
      { id: "tc-Sales", name: "Transfer Call (Sales)" },
    ];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [
        { name: "Sales", routerNode: { id: "router-Sales" }, endMode: "transfer" },
        { name: "Other", routerNode: { id: "router-Other" }, endMode: "transfer" },
      ],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "callback" } }), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, pathName: "Sales", mode: "callback" });
    // Multi-path: a new per-path Close (Sales) is created and the router edges to it.
    const newClose = nodes.find((n: any) => n.name === "Close (Sales)");
    expect(newClose).toBeDefined();
    expect(router.else_edge.destination_node_id).toBe(newClose!.id);
    // Pre-Transfer + Transfer Call for Sales removed
    expect(nodes.find((n: any) => n.name === "Pre-Transfer (Sales)")).toBeUndefined();
    expect(nodes.find((n: any) => n.name === "Transfer Call (Sales)")).toBeUndefined();
    expect(mockPushFlowToRetell).toHaveBeenCalled();
    const updateCall = mockUpdateOne.mock.calls[0];
    expect(updateCall[1].$set.path_end_modes).toEqual({ Other: "transfer" });
  });

  it("single-path callback toggle reuses the singleton Close node", async () => {
    const doc = makeDoc({
      dispatch_call_number: "+15555",
      path_end_modes: { Solo: "transfer" },
    });
    mockGetClientDocument.mockResolvedValue(doc);
    const router = { id: "router-Solo", else_edge: { destination_node_id: "pt-Solo" } };
    const nodes: any[] = [
      router,
      { id: "close", name: "Close", instruction: { type: "prompt", text: "x" }, always_edge: { destination_node_id: "cr", id: "ae", transition_condition: { type: "prompt", prompt: "Always" } } },
      { id: "pt-Solo", name: "Pre-Transfer (Solo)" },
      { id: "tc-Solo", name: "Transfer Call (Solo)" },
    ];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Solo", routerNode: { id: "router-Solo" }, endMode: "transfer" }],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Solo", mode: "callback" } }), res);
    expect(res._status).toBe(200);
    // Single-path: rewires to the singleton "Close" node — no per-path clone.
    expect(router.else_edge.destination_node_id).toBe("close");
    expect(nodes.find((n: any) => n.name === "Close (Solo)")).toBeUndefined();
  });

  it("transfer toggle removes the path's per-path Close node", async () => {
    const doc = makeDoc({ dispatch_call_number: "+15555" });
    mockGetClientDocument.mockResolvedValue(doc);
    const router: any = { id: "router-Sales", else_edge: { destination_node_id: "close-Sales" } };
    const nodes: any[] = [
      router,
      { id: "close-Sales", name: "Close (Sales)", instruction: { type: "prompt", text: "x" }, always_edge: { destination_node_id: "cr", id: "ae", transition_condition: { type: "prompt", prompt: "Always" } } },
      { id: "close-Other", name: "Close (Other)" },
      { id: "cr", name: "Closing Remarks" },
    ];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [
        { name: "Sales", routerNode: { id: "router-Sales" }, endMode: "callback" },
        { name: "Other", routerNode: { id: "router-Other" }, endMode: "callback" },
      ],
      closeNode: { id: "close-Sales" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "transfer" } }), res);
    expect(res._status).toBe(200);
    expect(nodes.find((n: any) => n.name === "Close (Sales)")).toBeUndefined();
    // Other path's Close node is preserved.
    expect(nodes.find((n: any) => n.name === "Close (Other)")).toBeDefined();
  });

  it("switches a path to transfer: creates Pre-Transfer + Transfer Call + recovery", async () => {
    const doc = makeDoc({ dispatch_call_number: "+15555" });
    mockGetClientDocument.mockResolvedValue(doc);
    const router: any = { id: "router-Sales", else_edge: { destination_node_id: "close" } };
    const nodes: any[] = [router, { id: "close", name: "Close" }, { id: "cr", name: "Closing Remarks" }];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Sales", routerNode: { id: "router-Sales" }, endMode: "callback" }],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "transfer" } }), res);

    expect(res._status).toBe(200);
    expect(nodes.find((n: any) => n.name === "Pre-Transfer (Sales)")).toBeDefined();
    expect(nodes.find((n: any) => n.name === "Transfer Call (Sales)")).toBeDefined();
    expect(nodes.find((n: any) => n.name === "Live Transfer Recovery")).toBeDefined();
    // Router else_edge rewired to Pre-Transfer
    expect(router.else_edge.destination_node_id).toContain("node-pretransfer-");
    expect(mockBuildWarmTransferOption).toHaveBeenCalledWith("v1");
  });

  it("uses per-path dispatch override when present", async () => {
    const doc = makeDoc({
      dispatch_call_number: "+15555",
      dispatch_by_type: { Sales: { dispatch_call_number: "+19999" } },
    });
    mockGetClientDocument.mockResolvedValue(doc);
    const router: any = { id: "router-Sales", else_edge: { destination_node_id: "close" } };
    const nodes: any[] = [router, { id: "close", name: "Close" }];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Sales", routerNode: { id: "router-Sales" }, endMode: "callback" }],
      closeNode: { id: "close" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-path-end-mode",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", mode: "transfer" } }), res);
    expect(res._status).toBe(200);
    expect(res._json.transferDestination).toBe("+19999");
    const tc = nodes.find((n: any) => n.name === "Transfer Call (Sales)");
    expect((tc.transfer_destination as any).number).toBe("+19999");
  });
});
