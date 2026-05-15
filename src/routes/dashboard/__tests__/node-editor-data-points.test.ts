import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { makeRes, makeReq, makeDoc, runRoute as runRouteHelper } from "./node-editor-helpers.js";

const {
  mockGetClientDocument, mockLoadClientsFromDb, mockGetDb, mockUpdateOne,
  mockFetchRetellAgent, mockExtractVariables,
  mockParseConversationFlow, mockValidateConversationFlow,
  mockCreateVersionSnapshot, mockLogAudit,
  mockDeriveNotificationConfig, mockDeriveMultiPathNotificationConfig,
  mockGetDataPointDefaults, mockResolveDataPoints,
  mockRegenerateDataChain, mockApplyRegeneratedChain,
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
  mockDeriveMultiPathNotificationConfig: vi.fn(),
  mockGetDataPointDefaults: vi.fn(),
  mockResolveDataPoints: vi.fn(),
  mockRegenerateDataChain: vi.fn(),
  mockApplyRegeneratedChain: vi.fn(),
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
  pushFlowToRetell: vi.fn(),
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
  deriveMultiPathNotificationConfig: (...a: any[]) => mockDeriveMultiPathNotificationConfig(...a),
  toLabel: (n: string) => n.replace(/_/g, " "),
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
vi.mock("../../../lib/agent-generator/data-point-registry.js", () => ({
  PATH_TAKEN_VAR: "path_taken",
  INTERNAL_VARS: new Set(["path_taken", "phone_number_collected"]),
}));
vi.mock("../../../lib/agent-generator/node-builders.js", () => ({
  makeIdFactory: vi.fn(), buildTransitionNode: vi.fn(),
  buildDataChain: vi.fn(), buildWarmTransferOption: vi.fn(),
  DEFAULT_LIVE_TRANSFER_RECOVERY_PROMPT: "fallback prompt",
}));
vi.mock("../../../lib/agent-generator/warm-transfer-agent-version.js", () => ({
  getWarmTransferAgentVersion: vi.fn(),
}));
vi.mock("../../../lib/build-notification.js", () => ({ renderTemplate: vi.fn() }));

const { nodeEditorRouter } = await import("../node-editor.js");

const runRoute = (method: string, path: string, req: Request, res: Response) =>
  runRouteHelper(nodeEditorRouter, method, path, req, res);

// ── Helpers for dataChain shapes ───────────────────────────────────────────

function makeDp(name: string, label = name) {
  return {
    variableName: name,
    label,
    conversationPrompt: `Ask for ${label}`,
    forwardCondition: "got it",
    variableDefs: [{ name, type: "string", description: "", choices: [] }],
    collectNode: { id: `collect-${name}`, name: `Collect ${label}` },
    confirmNode: { id: `confirm-${name}` },
  };
}

function makePath(name: string, dpNames: string[]) {
  return {
    name,
    transitionNode: { id: `tn-${name}` },
    routerNode: { id: `rn-${name}`, raw: { edges: [] } },
    frontExtractNode: { id: `fe-${name}` },
    dataChain: dpNames.map((n) => makeDp(n)),
    endMode: "callback",
    transferDestination: null,
  };
}

beforeEach(() => {
  for (const m of [
    mockGetClientDocument, mockLoadClientsFromDb, mockGetDb, mockUpdateOne,
    mockFetchRetellAgent, mockExtractVariables, mockParseConversationFlow,
    mockValidateConversationFlow, mockCreateVersionSnapshot, mockLogAudit,
    mockDeriveNotificationConfig, mockDeriveMultiPathNotificationConfig,
    mockGetDataPointDefaults, mockResolveDataPoints,
    mockRegenerateDataChain, mockApplyRegeneratedChain,
  ]) m.mockReset();

  mockUpdateOne.mockResolvedValue({});
  mockGetDb.mockReturnValue({ collection: () => ({ updateOne: mockUpdateOne }) });
  mockLoadClientsFromDb.mockResolvedValue(undefined);
  mockExtractVariables.mockReturnValue([]);
  mockDeriveNotificationConfig.mockReturnValue({ message_types: {}, default_message_type: null });
  mockDeriveMultiPathNotificationConfig.mockReturnValue({ message_types: {}, default_message_type: null });
  mockValidateConversationFlow.mockReturnValue([]);
  mockCreateVersionSnapshot.mockResolvedValue({});
  mockLogAudit.mockResolvedValue({});
  mockGetDataPointDefaults.mockResolvedValue({
    full_name: { variableName: "full_name", label: "Name" },
    email: { variableName: "email", label: "Email" },
    phone: { variableName: "phone", label: "Phone" },
  });
  mockRegenerateDataChain.mockReturnValue({});
});

// ── add-data-point ─────────────────────────────────────────────────────────

describe("POST /:agentId/add-data-point", () => {
  it("returns 400 when dataPointKey missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when dataPointKey is unknown", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockImplementation(() => { throw new Error("unknown"); });
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "bogus" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/Unknown data point key/);
  });

  it("returns 404 when path is not found", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "email", label: "Email" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email", pathName: "Sales" } }), res);
    expect(res._status).toBe(404);
    expect(res._json.availablePaths).toEqual(["Default"]);
  });

  it("returns 400 when variable already exists in path", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "full_name", label: "Name" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name", "email"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "full_name" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/already exists/);
  });

  it("returns 500 when Close node missing", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "email", label: "Email" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name"])],
      closeNode: undefined,
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email" } }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/Close node/);
  });

  it("inserts at end when position omitted, audits success", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "email", label: "Email" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email" } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      success: true, variableName: "email", label: "Email", position: 1, pathName: "Default",
    });
    expect(mockRegenerateDataChain).toHaveBeenCalled();
    expect(mockApplyRegeneratedChain).toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "add_data_point", "acme/agent_1",
      expect.objectContaining({ dataPointKey: "email", pathName: "Default", position: 1 }),
    );
  });

  it("clamps position to valid range when given out-of-bounds", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "email", label: "Email" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name", "phone"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email", position: 99 } }), res);
    expect(res._status).toBe(200);
    expect(res._json.position).toBe(2); // clamped to length
  });

  it("returns 400 when post-regeneration validation fails", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "email", label: "Email" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    mockValidateConversationFlow.mockReturnValue([{ code: "X", message: "bad" }]);
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/Validation failed/);
  });

  // ── Regression for the "test-notify shows scheduling instead of preferred_day/preferred_time" bug ──
  it("multi-path agents call deriveMultiPathNotificationConfig (not single-path)", async () => {
    // Pre-fix: storeCanonical always called the single-path derivation,
    // which produced "service_request" as the message_types key. The
    // doc had multi-path keys ("service_call", "emergency_call", …),
    // so the existingKeys===newKeys overwrite-guard skipped the update —
    // message_types stayed stale forever, holding the old field keys
    // (e.g. "scheduling" instead of preferred_day / preferred_time).
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "email", label: "Email" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    // Two paths → multi-path → should use deriveMultiPath, not the single-path version.
    const pathA = makePath("service_call", ["full_name"]);
    pathA.frontExtractNode = {
      ...pathA.frontExtractNode,
      raw: { variables: [{ name: "full_name" }, { name: "preferred_day" }, { name: "preferred_time" }] },
    } as any;
    const pathB = makePath("emergency_call", ["full_name"]);
    pathB.frontExtractNode = {
      ...pathB.frontExtractNode,
      raw: { variables: [{ name: "full_name" }, { name: "phone" }] },
    } as any;
    mockParseConversationFlow.mockReturnValue({
      paths: [pathA, pathB],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });

    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email" } }), res);
    expect(res._status).toBe(200);

    // Multi-path version called with one entry per path
    expect(mockDeriveMultiPathNotificationConfig).toHaveBeenCalled();
    const [pathVariables] = mockDeriveMultiPathNotificationConfig.mock.calls[0];
    expect(pathVariables).toHaveLength(2);
    expect(pathVariables[0].name).toBe("service_call");
    expect(pathVariables[0].variables.map((v: any) => v.key))
      .toEqual(["full_name", "preferred_day", "preferred_time"]);
    expect(pathVariables[1].name).toBe("emergency_call");
    // Single-path version NOT called for multi-path agents
    expect(mockDeriveNotificationConfig).not.toHaveBeenCalled();
  });

  it("single-path agents still use deriveNotificationConfig (no regression)", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockResolveDataPoints.mockReturnValue([{ variableName: "email", label: "Email" }]);
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockExtractVariables.mockReturnValue([{ key: "full_name", label: "Full Name" }]);
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/add-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { dataPointKey: "email" } }), res);
    expect(res._status).toBe(200);
    expect(mockDeriveNotificationConfig).toHaveBeenCalled();
    expect(mockDeriveMultiPathNotificationConfig).not.toHaveBeenCalled();
  });
});

// ── remove-data-point ──────────────────────────────────────────────────────

describe("POST /:agentId/remove-data-point", () => {
  it("returns 400 when variableName missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/remove-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/remove-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableName: "email" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 404 when variable not in path", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name", "phone"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/remove-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableName: "email" } }), res);
    expect(res._status).toBe(404);
    expect(res._json.existingVariables).toEqual(["full_name", "phone"]);
  });

  it("returns 400 when removing the last data point", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/remove-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableName: "full_name" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/last data point/);
  });

  it("removes successfully and audits", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name", "email"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/remove-data-point",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableName: "email" } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, variableName: "email", pathName: "Default" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "remove_data_point", "acme/agent_1",
      { variableName: "email", pathName: "Default" },
    );
  });
});

// ── reorder-data-points ────────────────────────────────────────────────────

describe("POST /:agentId/reorder-data-points", () => {
  it("returns 400 when variableNames not an array", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/reorder-data-points",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableNames: "x" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when variableNames is empty", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/reorder-data-points",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableNames: [] } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/reorder-data-points",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableNames: ["a"] } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 with missing/extra when names don't match path", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name", "email"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/reorder-data-points",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableNames: ["full_name", "phone"] } }), res);
    expect(res._status).toBe(400);
    expect(res._json.missing).toEqual(["email"]);
    expect(res._json.extra).toEqual(["phone"]);
  });

  it("reorders successfully and audits", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [makePath("Default", ["full_name", "email"])],
      closeNode: { id: "close" },
      closingNodes: [{ name: "Close Question", id: "close-question" }],
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/reorder-data-points",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { variableNames: ["email", "full_name"] } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, variableNames: ["email", "full_name"], pathName: "Default" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "reorder_data_points", "acme/agent_1",
      { variableNames: ["email", "full_name"], pathName: "Default" },
    );
  });
});
