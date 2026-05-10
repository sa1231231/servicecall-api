import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { makeRes, makeReq, makeDoc, runRoute as runRouteHelper } from "./node-editor-helpers.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

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
  mockGetVersion,
  mockListVersions,
  mockGetLatestVersion,
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
  mockGetVersion: vi.fn(),
  mockListVersions: vi.fn(),
  mockGetLatestVersion: vi.fn(),
  mockLogAudit: vi.fn(),
  mockDeriveNotificationConfig: vi.fn(),
  mockRequireRoot: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  config: { RETELL_API_KEY: "test_key" },
}));

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

vi.mock("../../../lib/db.js", () => ({
  getDb: (...a: any[]) => mockGetDb(...a),
}));

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
  getVersion: (...a: any[]) => mockGetVersion(...a),
  listVersions: (...a: any[]) => mockListVersions(...a),
  getLatestVersion: (...a: any[]) => mockGetLatestVersion(...a),
}));

vi.mock("../../../lib/audit.js", () => ({
  logAudit: (...a: any[]) => mockLogAudit(...a),
}));

vi.mock("../../../lib/notification-config.js", () => ({
  deriveNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
  deriveMultiPathNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
  toLabel: (n: string) => n.replace(/_/g, " "),
}));

vi.mock("../../../middleware/require-role.js", () => ({
  requireRoot: (req: Request, res: Response, next: NextFunction) =>
    mockRequireRoot(req, res, next),
}));

// Stubs for unused-by-publish-tests imports.
vi.mock("../../../lib/node-regenerator.js", () => ({
  regenerateDataChain: vi.fn(),
  applyRegeneratedChain: vi.fn(),
}));

vi.mock("../../../lib/data-point-defaults.js", () => ({
  getDataPointDefaults: vi.fn(),
}));

vi.mock("../../../lib/agent-generator/generate-agent.js", () => ({
  resolveDataPoints: vi.fn(),
}));

vi.mock("../../../lib/agent-generator/data-point-registry.js", () => ({
  PATH_TAKEN_VAR: "path_taken",
  INTERNAL_VARS: new Set(["path_taken", "phone_number_collected"]),
}));

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

vi.mock("../../../lib/build-notification.js", () => ({
  renderTemplate: vi.fn(),
}));

const { nodeEditorRouter } = await import("../node-editor.js");

const runRoute = (method: string, path: string, req: Request, res: Response) =>
  runRouteHelper(nodeEditorRouter, method, path, req, res);

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset call history AND implementations on every mock so a sticky
  // mockRejectedValue / mockResolvedValueOnce from one test cannot leak.
  for (const m of [
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
    mockGetVersion,
    mockListVersions,
    mockGetLatestVersion,
    mockLogAudit,
    mockDeriveNotificationConfig,
    mockRequireRoot,
  ]) {
    m.mockReset();
  }

  mockUpdateOne.mockResolvedValue({});
  mockGetDb.mockReturnValue({
    collection: () => ({ updateOne: mockUpdateOne }),
  });
  mockLoadClientsFromDb.mockResolvedValue(undefined);
  mockExtractVariables.mockReturnValue([]);
  mockDeriveNotificationConfig.mockReturnValue({
    message_types: {},
    default_message_type: null,
  });
  mockValidateConversationFlow.mockReturnValue([]);
  mockCreateVersionSnapshot.mockResolvedValue({});
  mockLogAudit.mockResolvedValue({});
  mockPushFlowToRetell.mockResolvedValue(undefined);
  mockAgentUpdate.mockResolvedValue(undefined);
  mockFlowUpdate.mockResolvedValue(undefined);
  mockRequireRoot.mockImplementation((_req, _res, next) => next());
});

describe("POST /:agentId/rollback", () => {
  it("returns 400 when versionId is missing", async () => {
    const req = makeReq({ params: { slug: "acme", agentId: "agent_1" }, body: {} });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/versionId/);
  });

  it("returns 404 when agent is not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);
    expect(res._status).toBe(404);
    expect(res._json.error).toBe("Agent not found");
  });

  it("returns 404 when slug does not match the agent", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ agent_id: "different" }));
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);
    expect(res._status).toBe(404);
  });

  it("returns 404 when version belongs to a different slug/agent", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "other",
      agentId: "agent_1",
      version: 5,
      canonicalJson: { conversationFlow: {} },
    });
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);
    expect(res._status).toBe(404);
    expect(res._json.error).toBe("Version not found");
  });

  it("returns 400 when version has no conversationFlow", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "acme",
      agentId: "agent_1",
      version: 5,
      canonicalJson: {},
    });
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} },
      conversationFlowId: "flow_1",
      agentName: "A",
    });
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
      username: "alice",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/conversationFlow/);
  });

  it("returns 400 when validation of the old flow fails", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "acme",
      agentId: "agent_1",
      version: 5,
      canonicalJson: { conversationFlow: { nodes: [] } },
    });
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} },
      conversationFlowId: "flow_1",
      agentName: "A",
    });
    mockValidateConversationFlow.mockReturnValue([
      { code: "MISSING_NODE", message: "broken" },
    ]);
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("Version failed validation");
    expect(res._json.errors).toHaveLength(1);
    expect(mockPushFlowToRetell).not.toHaveBeenCalled();
  });

  it("pushes flow, updates agent settings, and creates two version snapshots on success", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "acme",
      agentId: "agent_1",
      version: 5,
      canonicalJson: {
        conversationFlow: { nodes: [] },
        agent_name: "Old Name",
        voice_id: "voice_old",
      },
    });
    // First call = current, second = fresh after push
    mockFetchRetellAgent
      .mockResolvedValueOnce({
        canonicalJson: {
          conversationFlow: {},
          agent_name: "Current",
          voice_id: "voice_new",
        },
        conversationFlowId: "flow_1",
        agentName: "Current",
      })
      .mockResolvedValueOnce({
        canonicalJson: {
          conversationFlow: {},
          agent_name: "Old Name",
          voice_id: "voice_old",
        },
        conversationFlowId: "flow_1",
        agentName: "Old Name",
      });
    mockParseConversationFlow.mockReturnValue({ paths: [] });

    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
      username: "alice",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.restoredVersion).toBe(5);
    expect(res._json.agentSettingsUpdated).toEqual(
      expect.arrayContaining(["agent_name", "voice_id"]),
    );
    expect(mockPushFlowToRetell).toHaveBeenCalledTimes(1);
    expect(mockAgentUpdate).toHaveBeenCalledWith(
      "agent_1",
      expect.objectContaining({ agent_name: "Old Name", voice_id: "voice_old" }),
    );
    // Pre-rollback + post-rollback snapshots
    expect(mockCreateVersionSnapshot).toHaveBeenCalledTimes(2);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(),
      "rollback_agent",
      "acme/agent_1",
      expect.objectContaining({ restoredVersion: 5, versionId: "v123" }),
    );
  });

  it("restores the broader agent settings (backchannel, language, webhook_url, …) — not just the original 5", async () => {
    // Regression for the rollback gap: the handler used to hardcode a 5-field
    // list, leaving things like webhook_url, language, and backchannel drift
    // in place after rollback even though the snapshot contained them. The
    // shared EDITABLE_AGENT_SETTINGS constant now drives both edit-settings
    // and rollback so this test covers the full set.
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "acme",
      agentId: "agent_1",
      version: 5,
      canonicalJson: {
        conversationFlow: { nodes: [] },
        agent_name: "Old",
        webhook_url: "https://old.example.com/hook",
        language: "en-US",
        enable_backchannel: true,
        backchannel_frequency: 0.4,
        interruption_sensitivity: 0.7,
        ambient_sound: "coffee-shop",
        responsiveness: 0.9,
        end_call_after_silence_ms: 30000,
      },
    });
    mockFetchRetellAgent
      .mockResolvedValueOnce({
        canonicalJson: {
          conversationFlow: {},
          agent_name: "New",
          webhook_url: "https://new.example.com/hook",
          language: "es-ES",
          enable_backchannel: false,
          backchannel_frequency: 0.1,
          interruption_sensitivity: 0.2,
          ambient_sound: null,
          responsiveness: 0.5,
          end_call_after_silence_ms: 5000,
        },
        conversationFlowId: "flow_1",
        agentName: "New",
      })
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: {} },
        conversationFlowId: "flow_1",
        agentName: "Old",
      });
    mockParseConversationFlow.mockReturnValue({ paths: [] });

    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);

    expect(res._status).toBe(200);
    expect(mockAgentUpdate).toHaveBeenCalledTimes(1);
    const restored = mockAgentUpdate.mock.calls[0][1];
    // Every field that differed must be in the restore payload — not just
    // the legacy 5.
    expect(restored).toEqual(expect.objectContaining({
      agent_name: "Old",
      webhook_url: "https://old.example.com/hook",
      language: "en-US",
      enable_backchannel: true,
      backchannel_frequency: 0.4,
      interruption_sensitivity: 0.7,
      ambient_sound: "coffee-shop",
      responsiveness: 0.9,
      end_call_after_silence_ms: 30000,
    }));
  });

  it("skips agent.update when no agent-level settings differ", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "acme",
      agentId: "agent_1",
      version: 5,
      canonicalJson: { conversationFlow: { nodes: [] } },
    });
    mockFetchRetellAgent
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: {} },
        conversationFlowId: "flow_1",
        agentName: "A",
      })
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: {} },
        conversationFlowId: "flow_1",
        agentName: "A",
      });
    mockParseConversationFlow.mockReturnValue({ paths: [] });

    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);

    expect(res._status).toBe(200);
    expect(mockAgentUpdate).not.toHaveBeenCalled();
    expect(res._json.agentSettingsUpdated).toEqual([]);
  });

  it("re-derives path_end_modes and tolerates a parse failure during recovery", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "acme",
      agentId: "agent_1",
      version: 5,
      canonicalJson: { conversationFlow: { nodes: [] } },
    });
    mockFetchRetellAgent
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: {} },
        conversationFlowId: "flow_1",
        agentName: "A",
      })
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: {} },
        conversationFlowId: "flow_1",
        agentName: "A",
      });
    mockParseConversationFlow.mockImplementation(() => {
      throw new Error("parse blew up");
    });

    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);

    // Parse failure during path_end_modes derivation should be swallowed,
    // not turned into a 500. The rollback itself still succeeds.
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
  });

  it("returns 500 when pushFlowToRetell throws", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockGetVersion.mockResolvedValue({
      _id: "v123",
      slug: "acme",
      agentId: "agent_1",
      version: 5,
      canonicalJson: { conversationFlow: { nodes: [] } },
    });
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} },
      conversationFlowId: "flow_1",
      agentName: "A",
    });
    mockPushFlowToRetell.mockRejectedValue(new Error("retell down"));

    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { versionId: "v123" },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/rollback", req, res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe("retell down");
  });
});

describe("POST /:agentId/push (raw JSON)", () => {
  it("returns 400 when canonicalJson is missing", async () => {
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: {},
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/push", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/canonicalJson/);
  });

  it("returns 404 when agent is not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { canonicalJson: { conversationFlow: { nodes: [] } } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/push", req, res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when canonicalJson lacks conversationFlow", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { canonicalJson: { foo: 1 } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/push", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/conversationFlow/);
  });

  it("returns 400 when validation fails — does not push to Retell", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockValidateConversationFlow.mockReturnValue([
      { code: "BAD", message: "bad" },
    ]);
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { canonicalJson: { conversationFlow: { nodes: [] } } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/push", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toBe("Validation failed");
    expect(mockPushFlowToRetell).not.toHaveBeenCalled();
  });

  it("snapshots, pushes, re-fetches, snapshots again, and audits on success", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: { existing: true } },
        conversationFlowId: "flow_1",
        agentName: "A",
      })
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: { fresh: true } },
        conversationFlowId: "flow_1",
        agentName: "A",
      });

    const newJson = { conversationFlow: { nodes: [], updated: true } };
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { canonicalJson: newJson, description: "manual fix" },
      username: "alice",
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/push", req, res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(mockPushFlowToRetell).toHaveBeenCalledWith(
      expect.anything(),
      "flow_1",
      newJson,
    );
    expect(mockCreateVersionSnapshot).toHaveBeenCalledTimes(2);
    // Second snapshot should carry the user's description
    const secondSnapshot = mockCreateVersionSnapshot.mock.calls[1];
    expect(secondSnapshot[4]).toBe("manual fix");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(),
      "push_raw_json",
      "acme/agent_1",
      { description: "manual fix" },
    );
  });

  it("falls back to default description when none provided", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: {} },
        conversationFlowId: "flow_1",
        agentName: "A",
      })
      .mockResolvedValueOnce({
        canonicalJson: { conversationFlow: {} },
        conversationFlowId: "flow_1",
        agentName: "A",
      });
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { canonicalJson: { conversationFlow: { nodes: [] } } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/push", req, res);

    expect(res._status).toBe(200);
    const secondSnapshot = mockCreateVersionSnapshot.mock.calls[1];
    expect(secondSnapshot[4]).toBe("Raw JSON push");
  });

  it("returns 500 and skips audit when pushFlowToRetell throws", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc());
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: {} },
      conversationFlowId: "flow_1",
      agentName: "A",
    });
    mockPushFlowToRetell.mockRejectedValue(new Error("retell 500"));
    const req = makeReq({
      params: { slug: "acme", agentId: "agent_1" },
      body: { canonicalJson: { conversationFlow: { nodes: [] } } },
    });
    const res = makeRes();
    await runRoute("post", "/:agentId/push", req, res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe("retell 500");
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
