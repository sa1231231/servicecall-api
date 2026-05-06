import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { makeRes, makeReq, makeDoc, runRoute as runRouteHelper } from "./node-editor-helpers.js";

const {
  mockAgentUpdate,
  mockFlowUpdate,
  mockPhoneList,
  mockPhoneUpdate,
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
  mockPhoneList: vi.fn(),
  mockPhoneUpdate: vi.fn(),
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
    phoneNumber = { list: mockPhoneList, update: mockPhoneUpdate };
  },
}));
vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
  loadClientsFromDb: (...a: any[]) => mockLoadClientsFromDb(...a),
}));
vi.mock("../../../lib/db.js", () => ({ getDb: () => mockGetDb() }));
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
    mockAgentUpdate, mockFlowUpdate, mockPhoneList, mockPhoneUpdate,
    mockGetClientDocument, mockLoadClientsFromDb,
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
  mockPhoneList.mockResolvedValue([]);
  mockPhoneUpdate.mockResolvedValue(undefined);
});

function makeSnapshot(name: string) {
  return {
    canonicalJson: {
      agent_id: "agent_1",
      agent_name: name,
      conversationFlow: {
        global_prompt: `You are Anthony, an inbound receptionist for ${name}.`,
        nodes: [
          {
            id: "n1",
            type: "conversation",
            name: "Greeting",
            instruction: {
              text: `Welcome the caller: "Thank you for calling ${name}, this is Anthony."`,
            },
          },
        ],
      },
    },
    conversationFlowId: "flow_1",
    agentName: name,
    variables: [],
  };
}

describe("POST /:agentId/rename-business", () => {
  it("returns 400 when newName is missing", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: {} }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/newName/);
  });

  it("returns 400 when newName is whitespace", async () => {
    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { newName: "   " } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when agent not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { newName: "Beta" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns success with unchanged=true when names match", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme Plumbing" }));
    mockFetchRetellAgent.mockResolvedValue(makeSnapshot("Acme Plumbing"));
    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { newName: "Acme Plumbing" } }), res);
    expect(res._status).toBe(200);
    expect(res._json.unchanged).toBe(true);
    expect(mockPushFlowToRetell).not.toHaveBeenCalled();
    expect(mockAgentUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when validation fails on the renamed flow", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme Plumbing" }));
    mockFetchRetellAgent.mockResolvedValue(makeSnapshot("Acme Plumbing"));
    mockValidateConversationFlow.mockReturnValue([{ code: "X", message: "bad" }]);
    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: { newName: "Beta Plumbing" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/validation/i);
    expect(mockPushFlowToRetell).not.toHaveBeenCalled();
    expect(mockAgentUpdate).not.toHaveBeenCalled();
  });

  it("snapshots, replaces flow, updates client.name, audits — without touching agent_name or phone nicknames", async () => {
    mockGetClientDocument
      .mockResolvedValueOnce(makeDoc({ name: "Acme Plumbing" }))
      // resolveAgentId is called once at the top; storeCanonical does NOT
      // re-resolve (it takes the doc). Subsequent fetchRetellAgent in
      // pullLatest is mocked separately.
      .mockResolvedValue(makeDoc({ name: "Acme Plumbing" }));
    const initial = makeSnapshot("Acme Plumbing");
    const fresh = makeSnapshot("Beta Plumbing");
    mockFetchRetellAgent.mockResolvedValueOnce(initial).mockResolvedValueOnce(fresh);

    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { newName: "Beta Plumbing" },
        username: "alice",
      }), res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.oldName).toBe("Acme Plumbing");
    expect(res._json.newName).toBe("Beta Plumbing");

    // Snapshotted before edit.
    expect(mockCreateVersionSnapshot).toHaveBeenCalled();
    const snapDescription = mockCreateVersionSnapshot.mock.calls[0][4];
    expect(snapDescription).toContain("Acme Plumbing");
    expect(snapDescription).toContain("Beta Plumbing");

    // Pushed renamed flow to Retell — global_prompt should now contain new name.
    expect(mockPushFlowToRetell).toHaveBeenCalledTimes(1);
    const pushedCanonical = mockPushFlowToRetell.mock.calls[0][2];
    const pushedFlow = pushedCanonical.conversationFlow;
    expect(pushedFlow.global_prompt).toContain("Beta Plumbing");
    expect(pushedFlow.global_prompt).not.toContain("Acme Plumbing");
    expect(pushedFlow.nodes[0].instruction.text).toContain("Beta Plumbing");
    // With no display_name on the doc, agent_name in the canonical JSON
    // mirrors the new business name (preserves prior behavior for agents
    // that haven't customized their dashboard label).
    expect(pushedCanonical.agent_name).toBe("Beta Plumbing");

    // The Retell-side agent.update + phone-number nicknames are NOT touched
    // by rename-business anymore — those surfaces are owned by display_name
    // (PATCH /agents/:slug). See update-agent.ts.
    expect(mockAgentUpdate).not.toHaveBeenCalled();
    expect(mockPhoneList).not.toHaveBeenCalled();
    expect(mockPhoneUpdate).not.toHaveBeenCalled();

    // client.name updated in MongoDB.
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "acme" },
      { $set: { name: "Beta Plumbing" } },
    );

    // Audit logged.
    expect(mockLogAudit).toHaveBeenCalled();
    const auditAction = mockLogAudit.mock.calls[0][1];
    expect(auditAction).toBe("rename_business");
  });

  it("does not touch Retell phone numbers — even when the agent has many bound numbers", async () => {
    mockGetClientDocument.mockResolvedValue(
      makeDoc({ name: "Acme Plumbing", outbound_from_number: "+15550000000" }),
    );
    mockFetchRetellAgent
      .mockResolvedValueOnce(makeSnapshot("Acme Plumbing"))
      .mockResolvedValueOnce(makeSnapshot("Beta Plumbing"));

    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { newName: "Beta Plumbing" },
      }), res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    // Phone-number side effects belong to the display_name flow now.
    expect(mockPhoneList).not.toHaveBeenCalled();
    expect(mockPhoneUpdate).not.toHaveBeenCalled();
    // No nickname_* fields in the response — they were removed.
    expect(res._json.nickname_updated).toBeUndefined();
    expect(res._json.nickname_errors).toBeUndefined();
  });

  it("preserves the existing display_name in agent_name pin when one is set", async () => {
    mockGetClientDocument.mockResolvedValue(
      makeDoc({ name: "Acme Plumbing", display_name: "Acme HVAC (demo)" }),
    );
    mockFetchRetellAgent
      .mockResolvedValueOnce(makeSnapshot("Acme Plumbing"))
      .mockResolvedValueOnce(makeSnapshot("Beta Plumbing"));

    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { newName: "Beta Plumbing" },
      }), res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    // Renaming the business must not clobber the user's chosen dashboard label.
    const pushedCanonical = mockPushFlowToRetell.mock.calls[0][2];
    expect(pushedCanonical.agent_name).toBe("Acme HVAC (demo)");
    // Prompt text still rewritten with the new business name.
    expect(pushedCanonical.conversationFlow.global_prompt).toContain("Beta Plumbing");
    expect(mockAgentUpdate).not.toHaveBeenCalled();
  });

  it("uses oldName override when provided", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme Plumbing" }));
    // Snapshot says agent_name is "Different" — but the client passes
    // oldName: "Acme Plumbing", so the find/replace targets that name.
    const snapshot = {
      ...makeSnapshot("Acme Plumbing"),
      agentName: "Different",
    };
    mockFetchRetellAgent.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(makeSnapshot("Beta Plumbing"));

    const res = makeRes();
    await runRoute("post", "/:agentId/rename-business",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { newName: "Beta Plumbing", oldName: "Acme Plumbing" },
      }), res);

    expect(res._status).toBe(200);
    expect(res._json.oldName).toBe("Acme Plumbing");
    const pushedCanonical = mockPushFlowToRetell.mock.calls[0][2];
    expect(pushedCanonical.conversationFlow.global_prompt).toContain("Beta Plumbing");
  });
});
