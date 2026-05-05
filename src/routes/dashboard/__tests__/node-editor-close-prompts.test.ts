import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { makeRes, makeReq, makeDoc, runRoute as runRouteHelper } from "./node-editor-helpers.js";

// Focused tests for per-path Close prompt handling in save-and-publish.
// Lazy migration: a legacy single "Close" node splits into per-path Close
// nodes the first time the writer sees distinct prompts for different paths.

const {
  mockAgentUpdate, mockFlowUpdate, mockGetClientDocument, mockLoadClientsFromDb,
  mockGetDb, mockUpdateOne, mockFetchRetellAgent, mockPushFlowToRetell,
  mockExtractVariables, mockParseConversationFlow, mockValidateConversationFlow,
  mockCreateVersionSnapshot, mockLogAudit, mockDeriveNotificationConfig,
  mockRequireRoot, mockGetDataPointDefaults, mockResolveDataPoints,
  mockMakeIdFactory, mockBuildTransitionNode, mockBuildDataChain,
  mockBuildWarmTransferOption, mockGetWarmTransferAgentVersion, mockRenderTemplate,
  mockReplaceBusinessName,
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
  mockGetDataPointDefaults: vi.fn(),
  mockResolveDataPoints: vi.fn(),
  mockMakeIdFactory: vi.fn(),
  mockBuildTransitionNode: vi.fn(),
  mockBuildDataChain: vi.fn(),
  mockBuildWarmTransferOption: vi.fn(),
  mockGetWarmTransferAgentVersion: vi.fn(),
  mockRenderTemplate: vi.fn(),
  mockReplaceBusinessName: vi.fn(),
}));

vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key" } }));
vi.mock("retell-sdk", () => ({
  default: class { conversationFlow = { update: mockFlowUpdate }; agent = { update: mockAgentUpdate }; },
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
  getVersion: vi.fn(), listVersions: vi.fn(), getLatestVersion: vi.fn(),
}));
vi.mock("../../../lib/audit.js", () => ({ logAudit: (...a: any[]) => mockLogAudit(...a) }));
vi.mock("../../../lib/notification-config.js", () => ({
  deriveNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
}));
vi.mock("../../../middleware/require-role.js", () => ({
  requireRoot: (req: Request, res: Response, next: NextFunction) => mockRequireRoot(req, res, next),
}));
vi.mock("../../../lib/node-regenerator.js", () => ({
  regenerateDataChain: vi.fn(), applyRegeneratedChain: vi.fn(),
}));
vi.mock("../../../lib/data-point-defaults.js", () => ({
  getDataPointDefaults: (...a: any[]) => mockGetDataPointDefaults(...a),
}));
vi.mock("../../../lib/agent-generator/generate-agent.js", () => ({
  resolveDataPoints: (...a: any[]) => mockResolveDataPoints(...a),
}));
vi.mock("../../../lib/agent-generator/data-point-registry.js", () => ({ PATH_TAKEN_VAR: "path_taken" }));
vi.mock("../../../lib/agent-generator/node-builders.js", () => ({
  makeIdFactory: (...a: any[]) => mockMakeIdFactory(...a),
  buildTransitionNode: (...a: any[]) => mockBuildTransitionNode(...a),
  buildDataChain: (...a: any[]) => mockBuildDataChain(...a),
  buildWarmTransferOption: (...a: any[]) => mockBuildWarmTransferOption(...a),
  DEFAULT_LIVE_TRANSFER_RECOVERY_PROMPT: "fallback prompt",
}));
vi.mock("../../../lib/agent-generator/warm-transfer-agent-version.js", () => ({
  getWarmTransferAgentVersion: (...a: any[]) => mockGetWarmTransferAgentVersion(...a),
}));
vi.mock("../../../lib/build-notification.js", () => ({
  // Pass-through: identity render so we can assert on raw text in node.instruction.
  renderTemplate: (text: string) => text,
}));
vi.mock("../../../lib/replace-business-name.js", () => ({
  replaceBusinessName: (...a: any[]) => mockReplaceBusinessName(...a),
}));

const { nodeEditorRouter } = await import("../node-editor.js");

const runRoute = (method: string, path: string, req: Request, res: Response) =>
  runRouteHelper(nodeEditorRouter, method, path, req, res);

beforeEach(() => {
  for (const m of [
    mockAgentUpdate, mockFlowUpdate, mockGetClientDocument, mockLoadClientsFromDb,
    mockGetDb, mockUpdateOne, mockFetchRetellAgent, mockPushFlowToRetell,
    mockExtractVariables, mockParseConversationFlow, mockValidateConversationFlow,
    mockCreateVersionSnapshot, mockLogAudit, mockDeriveNotificationConfig, mockRequireRoot,
    mockGetDataPointDefaults, mockResolveDataPoints, mockMakeIdFactory, mockBuildTransitionNode,
    mockBuildDataChain, mockBuildWarmTransferOption, mockGetWarmTransferAgentVersion,
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
  mockGetDataPointDefaults.mockResolvedValue({});
});

// ── Per-path close handling ─────────────────────────────────────────────────

describe("POST /:agentId/save-and-publish — per-path Close prompts", () => {
  it("updates per-path Close (pathName) nodes when pathClosePrompts is provided", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme" }));
    const closeService = { id: "close-svc", name: "Close (Service)", instruction: { type: "prompt", text: "old service close" }, always_edge: { destination_node_id: "cr", id: "ae-svc" } };
    const closeSales = { id: "close-sls", name: "Close (Sales)", instruction: { type: "prompt", text: "old sales close" }, always_edge: { destination_node_id: "cr", id: "ae-sls" } };
    const routerSvc = { id: "router-svc", else_edge: { destination_node_id: "close-svc" } };
    const routerSls = { id: "router-sls", else_edge: { destination_node_id: "close-sls" } };
    const nodes: any[] = [routerSvc, routerSls, closeService, closeSales, { id: "cr", name: "Closing Remarks" }];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "Acme",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [
        { name: "Service", routerNode: { id: "router-svc" }, endMode: "callback" },
        { name: "Sales", routerNode: { id: "router-sls" }, endMode: "callback" },
      ],
      faqNode: null, introNode: { raw: { edges: [] } },
    });

    const res = makeRes();
    await runRoute("post", "/:agentId/save-and-publish",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { changes: { pathClosePrompts: { Service: "NEW SERVICE TEXT", Sales: "NEW SALES TEXT" } } },
      }), res);

    expect(res._status).toBe(200);
    expect(closeService.instruction.text).toBe("NEW SERVICE TEXT");
    expect(closeSales.instruction.text).toBe("NEW SALES TEXT");
    expect(mockPushFlowToRetell).toHaveBeenCalled();
  });

  it("lazy-migrates a legacy singleton Close into per-path Close nodes when prompts diverge", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme" }));
    const legacyClose = {
      id: "legacy-close", name: "Close",
      instruction: { type: "prompt", text: "shared legacy text" },
      always_edge: { destination_node_id: "cr", id: "ae-legacy", transition_condition: { type: "prompt", prompt: "Always" } },
    };
    const routerSvc = { id: "router-svc", else_edge: { destination_node_id: "legacy-close" } };
    const routerSls = { id: "router-sls", else_edge: { destination_node_id: "legacy-close" } };
    const nodes: any[] = [routerSvc, routerSls, legacyClose, { id: "cr", name: "Closing Remarks" }];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "Acme",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [
        { name: "Service", routerNode: { id: "router-svc" }, endMode: "callback" },
        { name: "Sales", routerNode: { id: "router-sls" }, endMode: "callback" },
      ],
      faqNode: null, introNode: { raw: { edges: [] } },
    });

    const res = makeRes();
    await runRoute("post", "/:agentId/save-and-publish",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { changes: { pathClosePrompts: { Service: "SERVICE TEXT", Sales: "SALES TEXT" } } },
      }), res);

    expect(res._status).toBe(200);
    // The first callback path claims the renamed legacy node
    expect(legacyClose.name).toBe("Close (Service)");
    expect(legacyClose.instruction.text).toBe("SERVICE TEXT");
    // The second path got a freshly-cloned per-path Close node
    const newClose = nodes.find((n: any) => n.name === "Close (Sales)");
    expect(newClose).toBeDefined();
    expect(newClose.id).not.toBe("legacy-close");
    expect(newClose.instruction.text).toBe("SALES TEXT");
    // Sales' router was rewired to the new node
    expect(routerSls.else_edge.destination_node_id).toBe(newClose.id);
    // Service's router is unchanged (still pointing to the renamed legacy node)
    expect(routerSvc.else_edge.destination_node_id).toBe("legacy-close");
  });

  it("single-path agents update the singleton Close in place (no rename)", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme" }));
    const close = {
      id: "close", name: "Close",
      instruction: { type: "prompt", text: "old" },
      always_edge: { destination_node_id: "cr", id: "ae" },
    };
    const router = { id: "router", else_edge: { destination_node_id: "close" } };
    const nodes: any[] = [router, close, { id: "cr", name: "Closing Remarks" }];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "Acme",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [{ name: "Default", routerNode: { id: "router" }, endMode: "callback" }],
      faqNode: null, introNode: { raw: { edges: [] } },
    });

    const res = makeRes();
    await runRoute("post", "/:agentId/save-and-publish",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { changes: { pathClosePrompts: { Default: "new text" } } },
      }), res);

    expect(res._status).toBe(200);
    expect(close.name).toBe("Close"); // unchanged — single-path keeps singleton name
    expect(close.instruction.text).toBe("new text");
    expect(nodes.find((n: any) => n.name === "Close (Default)")).toBeUndefined();
  });

  it("legacy changes.closePrompt (single string) applies to every callback path", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme" }));
    const closeSvc = {
      id: "close-svc", name: "Close (Service)",
      instruction: { type: "prompt", text: "old svc" },
      always_edge: { destination_node_id: "cr", id: "ae-svc" },
    };
    const closeSls = {
      id: "close-sls", name: "Close (Sales)",
      instruction: { type: "prompt", text: "old sls" },
      always_edge: { destination_node_id: "cr", id: "ae-sls" },
    };
    const routerSvc = { id: "router-svc", else_edge: { destination_node_id: "close-svc" } };
    const routerSls = { id: "router-sls", else_edge: { destination_node_id: "close-sls" } };
    const nodes: any[] = [routerSvc, routerSls, closeSvc, closeSls, { id: "cr", name: "Closing Remarks" }];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "Acme",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [
        { name: "Service", routerNode: { id: "router-svc" }, endMode: "callback" },
        { name: "Sales", routerNode: { id: "router-sls" }, endMode: "callback" },
      ],
      faqNode: null, introNode: { raw: { edges: [] } },
    });

    const res = makeRes();
    await runRoute("post", "/:agentId/save-and-publish",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { changes: { closePrompt: "GLOBAL_NEW_CLOSE" } },
      }), res);

    expect(res._status).toBe(200);
    expect(closeSvc.instruction.text).toBe("GLOBAL_NEW_CLOSE");
    expect(closeSls.instruction.text).toBe("GLOBAL_NEW_CLOSE");
  });

  it("transfer paths in pathClosePrompts are ignored (no Close node to update)", async () => {
    mockGetClientDocument.mockResolvedValue(makeDoc({ name: "Acme" }));
    const closeSvc = {
      id: "close-svc", name: "Close (Service)",
      instruction: { type: "prompt", text: "old svc" },
      always_edge: { destination_node_id: "cr", id: "ae" },
    };
    const ptEm = { id: "pt-em", name: "Pre-Transfer (Emergency)" };
    const routerSvc = { id: "router-svc", else_edge: { destination_node_id: "close-svc" } };
    const routerEm = { id: "router-em", else_edge: { destination_node_id: "pt-em" } };
    const nodes: any[] = [routerSvc, routerEm, closeSvc, ptEm, { id: "cr", name: "Closing Remarks" }];
    mockFetchRetellAgent.mockResolvedValue({
      canonicalJson: { conversationFlow: { nodes } }, conversationFlowId: "f1", agentName: "Acme",
    });
    mockParseConversationFlow.mockReturnValue({
      paths: [
        { name: "Service", routerNode: { id: "router-svc" }, endMode: "callback" },
        { name: "Emergency", routerNode: { id: "router-em" }, endMode: "transfer" },
      ],
      faqNode: null, introNode: { raw: { edges: [] } },
    });

    const res = makeRes();
    await runRoute("post", "/:agentId/save-and-publish",
      makeReq({
        params: { slug: "acme", agentId: "agent_1" },
        body: { changes: { pathClosePrompts: { Service: "NEW", Emergency: "should be ignored" } } },
      }), res);

    expect(res._status).toBe(200);
    expect(closeSvc.instruction.text).toBe("NEW");
    // No Close (Emergency) was created — transfer paths skip Close entirely
    expect(nodes.find((n: any) => n.name === "Close (Emergency)")).toBeUndefined();
  });
});
