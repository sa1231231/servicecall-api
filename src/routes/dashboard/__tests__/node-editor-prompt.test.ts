import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { makeRes, makeReq, makeDoc, runRoute as runRouteHelper } from "./node-editor-helpers.js";

const {
  mockAgentUpdate,
  mockFlowUpdate,
  mockGetClientDocument,
  mockLoadClientsFromDb,
  mockGetDb,
  mockUpdateOne,
  mockFetchRetellAgent,
  mockPushFlowToRetell,
  mockExtractVariables,
  mockParseConversationFlow,
  mockValidateConversationFlow,
  mockCreateVersionSnapshot,
  mockLogAudit,
  mockDeriveNotificationConfig,
  mockRequireRoot,
} = vi.hoisted(() => ({
  mockAgentUpdate: vi.fn(),
  mockFlowUpdate: vi.fn(),
  mockGetClientDocument: vi.fn(),
  mockLoadClientsFromDb: vi.fn(),
  mockGetDb: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockFetchRetellAgent: vi.fn(),
  mockPushFlowToRetell: vi.fn(),
  mockExtractVariables: vi.fn(),
  mockParseConversationFlow: vi.fn(),
  mockValidateConversationFlow: vi.fn(),
  mockCreateVersionSnapshot: vi.fn(),
  mockLogAudit: vi.fn(),
  mockDeriveNotificationConfig: vi.fn(),
  mockRequireRoot: vi.fn(),
}));

vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key" } }));
vi.mock("retell-sdk", () => ({
  default: class {
    conversationFlow = { update: mockFlowUpdate };
    agent = { update: mockAgentUpdate };
  },
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
  getVersion: vi.fn(),
  listVersions: vi.fn(),
  getLatestVersion: vi.fn(),
}));
vi.mock("../../../lib/audit.js", () => ({
  logAudit: (...a: any[]) => mockLogAudit(...a),
}));
vi.mock("../../../lib/notification-config.js", () => ({
  deriveNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
}));
vi.mock("../../../middleware/require-role.js", () => ({
  requireRoot: (req: Request, res: Response, next: NextFunction) =>
    mockRequireRoot(req, res, next),
}));
vi.mock("../../../lib/node-regenerator.js", () => ({
  regenerateDataChain: vi.fn(),
  applyRegeneratedChain: vi.fn(),
}));
vi.mock("../../../lib/data-point-defaults.js", () => ({ getDataPointDefaults: vi.fn() }));
vi.mock("../../../lib/agent-generator/generate-agent.js", () => ({ resolveDataPoints: vi.fn() }));
vi.mock("../../../lib/agent-generator/data-point-registry.js", () => ({ PATH_TAKEN_VAR: "path_taken" }));
vi.mock("../../../lib/agent-generator/node-builders.js", () => ({
  makeIdFactory: vi.fn(),
  buildTransitionNode: vi.fn(),
  buildDataChain: vi.fn(),
  buildWarmTransferOption: vi.fn(),
  DEFAULT_LIVE_TRANSFER_RECOVERY_PROMPT: "fallback prompt",
}));
vi.mock("../../../lib/agent-generator/warm-transfer-agent-version.js", () => ({
  getWarmTransferAgentVersion: vi.fn(),
}));
vi.mock("../../../lib/build-notification.js", () => ({ renderTemplate: vi.fn() }));

const { nodeEditorRouter } = await import("../node-editor.js");

const runRoute = (method: string, path: string, req: Request, res: Response) =>
  runRouteHelper(nodeEditorRouter, method, path, req, res);

beforeEach(() => {
  for (const m of [
    mockAgentUpdate, mockFlowUpdate, mockGetClientDocument, mockLoadClientsFromDb,
    mockGetDb, mockUpdateOne, mockFetchRetellAgent, mockPushFlowToRetell,
    mockExtractVariables, mockParseConversationFlow, mockValidateConversationFlow,
    mockCreateVersionSnapshot, mockLogAudit, mockDeriveNotificationConfig, mockRequireRoot,
  ]) m.mockReset();

  mockUpdateOne.mockResolvedValue({});
  mockGetDb.mockReturnValue({ collection: () => ({ updateOne: mockUpdateOne }) });
  mockLoadClientsFromDb.mockResolvedValue(undefined);
  mockExtractVariables.mockReturnValue([]);
  mockDeriveNotificationConfig.mockReturnValue({ message_types: {}, default_message_type: null });
  mockValidateConversationFlow.mockReturnValue([]);
  mockCreateVersionSnapshot.mockResolvedValue({});
  mockLogAudit.mockResolvedValue({});
  mockAgentUpdate.mockResolvedValue(undefined);
  mockFlowUpdate.mockResolvedValue(undefined);
  mockPushFlowToRetell.mockResolvedValue(undefined);
  mockRequireRoot.mockImplementation((_req, _res, next) => next());
});

// ── edit-prompt ────────────────────────────────────────────────────────────

describe("POST /:agentId/edit-prompt", () => {
  it("returns 400 when nodeId is missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { instruction: "hi" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when instruction is empty", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { nodeId: "n1", instruction: "  " } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { nodeId: "n1", instruction: "ok" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 404 when target node is missing in flow", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [{ id: "other", type: "conversation", instruction: { text: "" } }] } },
      conversationFlowId: "f1", agentName: "A",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { nodeId: "missing", instruction: "ok" } }), res);
    expect(res._status).toBe(404);
    expect(res._json.error).toMatch(/not found/);
  });

  it("returns 400 when node is not a conversation node", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [{ id: "n1", type: "extract", instruction: { text: "" } }] } },
      conversationFlowId: "f1", agentName: "A",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { nodeId: "n1", instruction: "ok" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/conversation nodes/);
  });

  it("returns 400 when validation fails after edit", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [{ id: "n1", name: "Greeting", type: "conversation", instruction: { text: "old" } }] } },
      conversationFlowId: "f1", agentName: "A",
    });
    mockValidateConversationFlow.mockReturnValue([{ code: "X", message: "bad" }]);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { nodeId: "n1", instruction: "new prompt" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("Validation failed");
  });

  it("snapshots, applies edit, stores, and audits on success", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const node = { id: "n1", name: "Greeting", type: "conversation", instruction: { text: "old" } };
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes: [node] } },
      conversationFlowId: "f1", agentName: "A",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { nodeId: "n1", instruction: "new prompt" }, username: "alice" }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, nodeId: "n1", nodeName: "Greeting" });
    expect(node.instruction.text).toBe("new prompt");
    expect(mockCreateVersionSnapshot).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "edit_node_prompt", "acme/agent_1",
      { nodeId: "n1", nodeName: "Greeting" },
    );
    // edit-prompt does NOT push to Retell — user publishes explicitly
    expect(mockPushFlowToRetell).not.toHaveBeenCalled();
  });
});

// ── edit-global-prompt ─────────────────────────────────────────────────────

describe("POST /:agentId/edit-global-prompt", () => {
  it("returns 400 when globalPrompt missing or empty", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-global-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { globalPrompt: " " } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-global-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { globalPrompt: "p" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when validation fails", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockValidateConversationFlow.mockReturnValue([{ code: "X", message: "bad" }]);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-global-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { globalPrompt: "new" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("Validation failed");
  });

  it("applies edit and audits on success", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const flow: Record<string, unknown> = {};
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: flow }, conversationFlowId: "f1", agentName: "A",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-global-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { globalPrompt: "new global" }, username: "bob" }), res);
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(flow.global_prompt).toBe("new global");
    expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), "edit_global_prompt", "acme/agent_1");
  });

  it("returns 500 when fetchRetellAgent throws", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockRejectedValue(new Error("retell down"));
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-global-prompt",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { globalPrompt: "p" } }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe("retell down");
  });
});

// ── edit-transition ────────────────────────────────────────────────────────

describe("POST /:agentId/edit-transition", () => {
  it("returns 400 when pathName missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-transition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { transitionCondition: "x" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when transitionCondition empty", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-transition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", transitionCondition: "" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-transition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", transitionCondition: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 404 with availablePaths when path not found", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Support", transitionNode: { id: "tn1" } }],
      introNode: { raw: { edges: [] } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-transition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", transitionCondition: "x" } }), res);
    expect(res._status).toBe(404);
    expect(res._json.availablePaths).toEqual(["Support"]);
  });

  it("returns 500 when intro edge for path is missing (data integrity)", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: {}, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Sales", transitionNode: { id: "tn-sales" } }],
      introNode: { raw: { edges: [{ destination_node_id: "other", transition_condition: { prompt: "" } }] } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-transition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", transitionCondition: "x" } }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toMatch(/transition edge/);
  });

  it("updates the edge prompt and audits on success", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const edge = { destination_node_id: "tn-sales", transition_condition: { prompt: "old" } };
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Sales", transitionNode: { id: "tn-sales" } }],
      introNode: { raw: { edges: [edge] } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-transition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", transitionCondition: "user wants Sales" } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, pathName: "Sales" });
    expect(edge.transition_condition.prompt).toBe("user wants Sales");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "edit_transition", "acme/agent_1",
      { pathName: "Sales", transitionCondition: "user wants Sales" },
    );
  });

  it("returns 400 when post-edit validation fails", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const edge = { destination_node_id: "tn-sales", transition_condition: { prompt: "old" } };
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Sales", transitionNode: { id: "tn-sales" } }],
      introNode: { raw: { edges: [edge] } },
    });
    mockValidateConversationFlow.mockReturnValue([{ code: "X", message: "bad" }]);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-transition",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { pathName: "Sales", transitionCondition: "x" } }), res);
    expect(res._status).toBe(400);
  });
});

// ── edit-agent-settings ────────────────────────────────────────────────────

describe("POST /:agentId/edit-agent-settings", () => {
  it("returns 400 when no allowed settings provided", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-agent-settings",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { not_allowed: "x" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.allowed).toContain("agent_name");
  });

  it("filters out disallowed keys, keeps allowed", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent
      .mockResolvedValueOnce({ canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A" })
      .mockResolvedValueOnce({ canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A" });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-agent-settings",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { agent_name: "New", voice_speed: 1.2, hacker_field: "boom" },
      }), res);
    expect(res._status).toBe(200);
    expect(res._json.updated).toEqual(["agent_name", "voice_speed"]);
    expect(mockAgentUpdate).toHaveBeenCalledWith("agent_1", { agent_name: "New", voice_speed: 1.2 });
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-agent-settings",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { agent_name: "X" } }), res);
    expect(res._status).toBe(404);
  });

  it("audits with the list of fields updated", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-agent-settings",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { language: "en-US" } }), res);
    expect(res._status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(), "edit_agent_settings", "acme/agent_1",
      { fields: ["language"] },
    );
  });

  it("returns 500 when retell.agent.update throws", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f1", agentName: "A",
    });
    mockAgentUpdate.mockRejectedValue(new Error("rate limited"));
    const res = makeRes();
    await runRoute("post", "/:agentId/edit-agent-settings",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { agent_name: "X" } }), res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe("rate limited");
  });
});
