import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const {
  mockGetClientDocument, mockGeneratePortalToken,
  mockListDeletedClients, mockRestoreClient, mockDeleteClient,
  mockGetCallLogById,
  mockSendSmsToAll,
  mockGetSettings, mockUpdateSettings,
  mockRunBackup,
  mockGetDataPointDefaultsWithCategory, mockUpdateDataPointDefault,
  mockCreateDataPointDefault, mockDeleteDataPointDefault, mockReorderDataPointDefaults,
  mockLogAudit, mockAlertRootIfNeeded,
  mockListUsers, mockCreateUser, mockDeleteUser, mockUpdateUserPermissions,
  mockGetClientCogs,
  mockPreviewBlast, mockSendBlast,
  mockAgentRetrieve, mockAgentUpdate, mockAgentDelete, mockFlowDelete,
  mockPhoneNumberList,
  mockListAgents, mockGetAgent, mockGetCalls, mockToggleShadow, mockToggleActive,
  mockUpdateAgent, mockCloneAgent, mockDeleteAgent, mockExportAgent,
  mockNodeEditorRouter, mockReleaseAgentResources,
} = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
  mockGeneratePortalToken: vi.fn(),
  mockListDeletedClients: vi.fn(),
  mockRestoreClient: vi.fn(),
  mockDeleteClient: vi.fn(),
  mockGetCallLogById: vi.fn(),
  mockSendSmsToAll: vi.fn(),
  mockGetSettings: vi.fn(),
  mockUpdateSettings: vi.fn(),
  mockRunBackup: vi.fn(),
  mockGetDataPointDefaultsWithCategory: vi.fn(),
  mockUpdateDataPointDefault: vi.fn(),
  mockCreateDataPointDefault: vi.fn(),
  mockDeleteDataPointDefault: vi.fn(),
  mockReorderDataPointDefaults: vi.fn(),
  mockLogAudit: vi.fn(),
  mockAlertRootIfNeeded: vi.fn(),
  mockListUsers: vi.fn(),
  mockCreateUser: vi.fn(),
  mockDeleteUser: vi.fn(),
  mockUpdateUserPermissions: vi.fn(),
  mockGetClientCogs: vi.fn(),
  mockPreviewBlast: vi.fn(),
  mockSendBlast: vi.fn(),
  mockAgentRetrieve: vi.fn(),
  mockAgentUpdate: vi.fn(),
  mockAgentDelete: vi.fn(),
  mockFlowDelete: vi.fn(),
  mockPhoneNumberList: vi.fn(),
  mockListAgents: vi.fn(),
  mockGetAgent: vi.fn(),
  mockGetCalls: vi.fn(),
  mockToggleShadow: vi.fn(),
  mockToggleActive: vi.fn(),
  mockUpdateAgent: vi.fn(),
  mockCloneAgent: vi.fn(),
  mockDeleteAgent: vi.fn(),
  mockExportAgent: vi.fn(),
  mockNodeEditorRouter: { stack: [] },
  mockReleaseAgentResources: vi.fn(),
}));

vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key", API_KEY: "internal_key" } }));
vi.mock("retell-sdk", () => ({
  default: class {
    agent = { retrieve: mockAgentRetrieve, update: mockAgentUpdate, delete: mockAgentDelete };
    conversationFlow = { delete: mockFlowDelete };
    phoneNumber = { list: mockPhoneNumberList };
  },
}));
vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
  generatePortalToken: (...a: any[]) => mockGeneratePortalToken(...a),
  listDeletedClients: (...a: any[]) => mockListDeletedClients(...a),
  restoreClient: (...a: any[]) => mockRestoreClient(...a),
  deleteClient: (...a: any[]) => mockDeleteClient(...a),
}));
vi.mock("../../../lib/call-log.js", () => ({ getCallLogById: (...a: any[]) => mockGetCallLogById(...a) }));
vi.mock("../../../lib/notify-sms.js", () => ({ sendSmsToAll: (...a: any[]) => mockSendSmsToAll(...a) }));
vi.mock("../../../lib/settings.js", () => ({
  getSettings: (...a: any[]) => mockGetSettings(...a),
  updateSettings: (...a: any[]) => mockUpdateSettings(...a),
}));
vi.mock("../../../lib/backup.js", () => ({ runBackup: (...a: any[]) => mockRunBackup(...a) }));
vi.mock("../../../lib/data-point-defaults.js", () => ({
  getDataPointDefaultsWithCategory: (...a: any[]) => mockGetDataPointDefaultsWithCategory(...a),
  updateDataPointDefault: (...a: any[]) => mockUpdateDataPointDefault(...a),
  createDataPointDefault: (...a: any[]) => mockCreateDataPointDefault(...a),
  deleteDataPointDefault: (...a: any[]) => mockDeleteDataPointDefault(...a),
  reorderDataPointDefaults: (...a: any[]) => mockReorderDataPointDefaults(...a),
  CATEGORY_ORDER: ["A", "B"],
  CATEGORY_LABELS: { A: "A label" },
}));
vi.mock("../../../middleware/require-role.js", () => ({
  // No-op middleware for tests; permission gating is tested separately.
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoot: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRootForProtectedSlug: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock("../../../lib/audit.js", () => ({
  logAudit: (...a: any[]) => mockLogAudit(...a),
}));
vi.mock("./node-editor.js", () => ({ nodeEditorRouter: mockNodeEditorRouter }));
vi.mock("../../../lib/root-alerts.js", () => ({
  alertRootIfNeeded: (...a: any[]) => mockAlertRootIfNeeded(...a),
}));
vi.mock("../../../lib/users.js", () => ({
  listUsers: (...a: any[]) => mockListUsers(...a),
  createUser: (...a: any[]) => mockCreateUser(...a),
  deleteUser: (...a: any[]) => mockDeleteUser(...a),
  updateUserPermissions: (...a: any[]) => mockUpdateUserPermissions(...a),
  PERMISSION_DEFS: [],
  DEFAULT_PERMISSIONS: {},
}));
vi.mock("../../../lib/billing-cogs.js", () => ({ getClientCogs: (...a: any[]) => mockGetClientCogs(...a) }));
vi.mock("../../../lib/blast-sms.js", () => ({
  previewBlast: (...a: any[]) => mockPreviewBlast(...a),
  sendBlast: (...a: any[]) => mockSendBlast(...a),
}));

// Imported handler stubs
vi.mock("./list-agents.js", () => ({ listAgentsHandler: mockListAgents }));
vi.mock("./get-agent.js", () => ({ getAgentHandler: mockGetAgent }));
vi.mock("./get-calls.js", () => ({ getCallsHandler: mockGetCalls }));
vi.mock("./toggle-shadow.js", () => ({ toggleShadowHandler: mockToggleShadow }));
vi.mock("./toggle-active.js", () => ({ toggleActiveHandler: mockToggleActive }));
vi.mock("./update-agent.js", () => ({ updateAgentHandler: mockUpdateAgent }));
vi.mock("./clone-agent.js", () => ({ cloneAgentHandler: mockCloneAgent }));
vi.mock("./delete-agent.js", () => ({ deleteAgentHandler: mockDeleteAgent }));
vi.mock("../agents/export-agent.js", () => ({ exportAgentHandler: mockExportAgent }));
vi.mock("../../../lib/release-agent-resources.js", () => ({
  releaseAgentResources: (...a: any[]) => mockReleaseAgentResources(...a),
}));

const { dashboardApiRouter, backupRouter } = await import("../index.js");

function makeRes(): Response & { _status: number; _json: any; _data: any; _headers: Record<string, string> } {
  const res: any = { _status: 200, _json: null, _data: null, _headers: {} };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  res.send = (data: any) => { res._data = data; return res; };
  res.setHeader = (k: string, v: string) => { res._headers[k] = v; return res; };
  res.type = () => res;
  return res;
}

function makeReq(opts: { params?: any; body?: any; query?: any; user?: any; protocol?: string; host?: string }): Request {
  const headers: Record<string, string> = { host: opts.host ?? "localhost:3000" };
  return {
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: opts.query ?? {},
    user: opts.user,
    protocol: opts.protocol ?? "https",
    headers,
    get: (h: string) => headers[h.toLowerCase()],
  } as any;
}

function findRoute(router: any, method: string, path: string) {
  for (const layer of router.stack as any[]) {
    if (!layer.route) continue;
    if (layer.route.path === path && layer.route.methods[method]) return layer.route.stack;
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

async function runRoute(router: any, method: string, path: string, req: Request, res: Response) {
  const stack = findRoute(router, method, path);
  for (let i = 0; i < stack.length; i++) {
    let advance = false; let nextErr: any = null;
    const next = (err?: any) => { if (err) nextErr = err; advance = true; };
    const result = stack[i].handle(req, res, next);
    if (result && typeof (result as Promise<unknown>).then === "function") await result;
    if (nextErr) throw nextErr;
    if (!advance) return;
  }
}

beforeEach(() => {
  for (const m of [
    mockGetClientDocument, mockGeneratePortalToken, mockListDeletedClients,
    mockRestoreClient, mockDeleteClient, mockGetCallLogById, mockSendSmsToAll,
    mockGetSettings, mockUpdateSettings, mockRunBackup,
    mockGetDataPointDefaultsWithCategory, mockUpdateDataPointDefault,
    mockCreateDataPointDefault, mockDeleteDataPointDefault, mockReorderDataPointDefaults,
    mockLogAudit, mockAlertRootIfNeeded,
    mockListUsers, mockCreateUser, mockDeleteUser, mockUpdateUserPermissions,
    mockGetClientCogs, mockPreviewBlast, mockSendBlast,
    mockAgentRetrieve, mockAgentUpdate, mockAgentDelete, mockFlowDelete,
  ]) m.mockReset();
  mockLogAudit.mockResolvedValue(undefined);
  mockAlertRootIfNeeded.mockReturnValue(undefined);
});

// ── Soft-deleted agents ────────────────────────────────────────────────────

describe("GET /deleted-agents", () => {
  it("returns the list of deleted clients", async () => {
    mockListDeletedClients.mockResolvedValue([{ _id: "old", name: "Old" }]);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/deleted-agents", makeReq({}), res);
    expect(res._json).toEqual([{ _id: "old", name: "Old" }]);
  });
});

describe("POST /deleted-agents/:slug/restore", () => {
  it("strips [DELETED — expires ...] suffix from Retell agent name and audits", async () => {
    mockGetClientDocument.mockResolvedValue({
      agent_id: "agent_1",
      retell_agents: { agent_1: {} },
    });
    mockAgentRetrieve.mockResolvedValue({ agent_name: "Acme [DELETED — expires 2026-12-01]" });
    mockAgentUpdate.mockResolvedValue(undefined);
    mockRestoreClient.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/deleted-agents/:slug/restore",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, slug: "acme" });
    expect(mockAgentUpdate).toHaveBeenCalledWith("agent_1", { agent_name: "Acme" });
    expect(mockRestoreClient).toHaveBeenCalledWith("acme");
    expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), "restore_agent", "acme");
  });

  it("does NOT call agent.update if name already clean", async () => {
    mockGetClientDocument.mockResolvedValue({
      agent_id: "agent_1",
      retell_agents: { agent_1: {} },
    });
    mockAgentRetrieve.mockResolvedValue({ agent_name: "Already Clean" });
    mockRestoreClient.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/deleted-agents/:slug/restore",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    expect(mockAgentUpdate).not.toHaveBeenCalled();
  });

  it("tolerates Retell retrieve failure and still restores", async () => {
    mockGetClientDocument.mockResolvedValue({
      agent_id: "agent_1",
      retell_agents: { agent_1: {} },
    });
    mockAgentRetrieve.mockRejectedValue(new Error("retell down"));
    mockRestoreClient.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/deleted-agents/:slug/restore",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    expect(mockRestoreClient).toHaveBeenCalled();
  });

  it("returns 500 when restore itself fails", async () => {
    mockGetClientDocument.mockResolvedValue({ agent_id: "agent_1", retell_agents: {} });
    mockAgentRetrieve.mockResolvedValue({ agent_name: "Clean" });
    mockRestoreClient.mockRejectedValue(new Error("db blew up"));
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/deleted-agents/:slug/restore",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(500);
  });
});

describe("DELETE /deleted-agents/:slug", () => {
  it("delegates external cleanup to releaseAgentResources, then permanent-deletes client", async () => {
    const doc = {
      agent_id: "agent_1",
      retell_agents: {
        agent_1: { conversationFlow: { conversation_flow_id: "flow_1" } },
        agent_2: { response_engine: { conversation_flow_id: "flow_2" } },
      },
    };
    mockGetClientDocument.mockResolvedValue(doc);
    mockReleaseAgentResources.mockResolvedValue({
      released: [{ phone_number: "+15550001111", phone_number_sid: "PN_a" }],
      errors: [],
    });
    mockDeleteClient.mockResolvedValue(undefined);

    const res = makeRes();
    await runRoute(dashboardApiRouter, "delete", "/deleted-agents/:slug",
      makeReq({ params: { slug: "acme" } }), res);

    expect(res._status).toBe(200);
    expect(mockReleaseAgentResources).toHaveBeenCalledWith("acme", doc, "permanent-delete");
    expect(mockDeleteClient).toHaveBeenCalledWith("acme");
    expect(res._json.released_numbers).toEqual([
      { phone_number: "+15550001111", phone_number_sid: "PN_a" },
    ]);
    // No cleanup_errors when the helper had none.
    expect(res._json.cleanup_errors).toBeUndefined();
  });

  it("surfaces cleanup errors in the response and still deletes the client", async () => {
    mockGetClientDocument.mockResolvedValue({
      agent_id: "agent_1",
      retell_agents: { agent_1: {} },
    });
    mockReleaseAgentResources.mockResolvedValue({
      released: [],
      errors: ["twilio release (+15550001111): not found"],
    });
    mockDeleteClient.mockResolvedValue(undefined);

    const res = makeRes();
    await runRoute(dashboardApiRouter, "delete", "/deleted-agents/:slug",
      makeReq({ params: { slug: "acme" } }), res);

    expect(res._status).toBe(200);
    expect(mockDeleteClient).toHaveBeenCalled();
    expect(res._json.cleanup_errors).toEqual([
      "twilio release (+15550001111): not found",
    ]);
  });
});

// ── Transcript ─────────────────────────────────────────────────────────────

describe("GET /agents/:slug/calls/:callId/transcript", () => {
  it("returns 404 when call not found or wrong slug", async () => {
    mockGetCallLogById.mockResolvedValue({ client_slug: "other", transcript: "t" });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/agents/:slug/calls/:callId/transcript",
      makeReq({ params: { slug: "acme", callId: "c1" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 404 when transcript not yet available", async () => {
    mockGetCallLogById.mockResolvedValue({ client_slug: "acme", transcript: null });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/agents/:slug/calls/:callId/transcript",
      makeReq({ params: { slug: "acme", callId: "c1" } }), res);
    expect(res._status).toBe(404);
  });

  it("sends the transcript with attachment headers", async () => {
    mockGetCallLogById.mockResolvedValue({ client_slug: "acme", transcript: "Hi there" });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/agents/:slug/calls/:callId/transcript",
      makeReq({ params: { slug: "acme", callId: "c1" } }), res);
    expect(res._data).toBe("Hi there");
    expect(res._headers["Content-Type"]).toMatch(/text\/plain/);
    expect(res._headers["Content-Disposition"]).toContain("transcript-c1.txt");
  });
});

// ── Portal Token (issue + verify) ──────────────────────────────────────────

describe("GET /agents/:slug/portal-token", () => {
  it("returns has_token: false when no token exists", async () => {
    mockGetClientDocument.mockResolvedValue({});
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/agents/:slug/portal-token",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._json).toEqual({ has_token: false, portal_url: null });
  });

  it("builds portal URL from request when token exists", async () => {
    mockGetClientDocument.mockResolvedValue({ portal_token: "tok123" });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/agents/:slug/portal-token",
      makeReq({ params: { slug: "acme" }, host: "app.example.com" }), res);
    expect(res._json.has_token).toBe(true);
    expect(res._json.portal_url).toBe("https://app.example.com/portal/acme?token=tok123");
  });
});

describe("POST /agents/:slug/portal-token", () => {
  it("returns 404 when client missing", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/portal-token",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(404);
  });

  it("generates token and returns URL", async () => {
    mockGetClientDocument.mockResolvedValue({});
    mockGeneratePortalToken.mockResolvedValue("new-tok");
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/portal-token",
      makeReq({ params: { slug: "acme" }, host: "x.com" }), res);
    expect(res._json.success).toBe(true);
    expect(res._json.portal_url).toBe("https://x.com/portal/acme?token=new-tok");
  });
});

// ── Comms (request-review, send-payment-link, send-portal-link) ────────────

describe("POST /agents/:slug/request-review", () => {
  it("returns 404 when client missing", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/request-review",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when google_review_url not configured", async () => {
    mockGetClientDocument.mockResolvedValue({});
    mockGetSettings.mockResolvedValue({});
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/request-review",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when no dispatch numbers", async () => {
    mockGetClientDocument.mockResolvedValue({ dispatch_text_numbers: [] });
    mockGetSettings.mockResolvedValue({ google_review_url: "https://r/", review_sms_message: "m" });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/request-review",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(400);
  });

  it("templates the URL into the message and sends to all numbers", async () => {
    mockGetClientDocument.mockResolvedValue({ dispatch_text_numbers: ["+1", "+2"] });
    mockGetSettings.mockResolvedValue({
      google_review_url: "https://review/",
      review_sms_message: "Pls review: {{google_review_url}}",
    });
    mockSendSmsToAll.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/request-review",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    expect(mockSendSmsToAll).toHaveBeenCalledWith(["+1", "+2"], "Pls review: https://review/");
  });

  it("returns 502 when SMS send fails", async () => {
    mockGetClientDocument.mockResolvedValue({ dispatch_text_numbers: ["+1"] });
    mockGetSettings.mockResolvedValue({ google_review_url: "https://r/", review_sms_message: "m" });
    mockSendSmsToAll.mockRejectedValue(new Error("twilio down"));
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/request-review",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(502);
  });
});

describe("POST /agents/:slug/send-instructions", () => {
  const verizon = { id: "verizon", label: "Verizon", message: "Hi {{business_name}}, forward to {{agent_phone}}." };

  it("returns 400 when body is missing the template id", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when client missing", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "verizon" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 404 when no template matches the id", async () => {
    mockGetClientDocument.mockResolvedValue({ dispatch_text_numbers: ["+1"] });
    mockGetSettings.mockResolvedValue({ setup_instructions: [verizon] });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "att" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when client has no dispatch numbers", async () => {
    mockGetClientDocument.mockResolvedValue({ dispatch_text_numbers: [], name: "Acme" });
    mockGetSettings.mockResolvedValue({ setup_instructions: [verizon] });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "verizon" } }), res);
    expect(res._status).toBe(400);
  });

  it("substitutes business_name + agent_phone and sends to all dispatch numbers", async () => {
    mockGetClientDocument.mockResolvedValue({
      dispatch_text_numbers: ["+15551111111", "+15552222222"],
      name: "Acme Plumbing",
      outbound_from_number: "+15559998888",
    });
    mockGetSettings.mockResolvedValue({ setup_instructions: [verizon] });
    mockSendSmsToAll.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "verizon" } }), res);
    expect(res._status).toBe(200);
    expect(res._json.label).toBe("Verizon");
    expect(mockSendSmsToAll).toHaveBeenCalledWith(
      ["+15551111111", "+15552222222"],
      "Hi Acme Plumbing, forward to +15559998888.",
    );
  });

  it("returns 502 when SMS send fails", async () => {
    mockGetClientDocument.mockResolvedValue({
      dispatch_text_numbers: ["+1"],
      name: "Acme",
      outbound_from_number: "+15550000000",
    });
    mockGetSettings.mockResolvedValue({ setup_instructions: [verizon] });
    mockSendSmsToAll.mockRejectedValue(new Error("twilio down"));
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "verizon" } }), res);
    expect(res._status).toBe(502);
  });

  it("falls back to Retell-live when outbound_from_number is missing on the doc", async () => {
    // Regression: legacy agents created via /agents/create or /agents/from-draft
    // before the provisioning-write fix shipped have outbound_from_number=null.
    // The handler now queries Retell for the agent's bound number as a
    // fallback so the SMS still goes out with the right phone embedded.
    const star = {
      id: "verizon",
      label: "Verizon",
      message: "Tap to dial: *72{{agent_phone_10}} ({{agent_phone}})",
    };
    mockGetClientDocument.mockResolvedValue({
      dispatch_text_numbers: ["+15551111111"],
      name: "Acme",
      agent_id: "agent_x",
      outbound_from_number: null,
    });
    mockGetSettings.mockResolvedValue({ setup_instructions: [star] });
    // Retell list returns one number bound to agent_x
    mockPhoneNumberList.mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_x", weight: 1 }] },
    ]);
    mockSendSmsToAll.mockResolvedValue(undefined);

    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "verizon" } }), res);

    expect(res._status).toBe(200);
    expect(mockSendSmsToAll).toHaveBeenCalledWith(
      ["+15551111111"],
      "Tap to dial: *728158804070 (+18158804070)",
    );
  });

  it("returns 400 when neither outbound_from_number nor a Retell binding can resolve the agent's phone", async () => {
    const star = { id: "verizon", label: "Verizon", message: "*72{{agent_phone_10}}" };
    mockGetClientDocument.mockResolvedValue({
      dispatch_text_numbers: ["+15551111111"],
      name: "Acme",
      agent_id: "agent_x",
      outbound_from_number: null,
    });
    mockGetSettings.mockResolvedValue({ setup_instructions: [star] });
    mockPhoneNumberList.mockResolvedValue([]); // no Retell bindings

    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "verizon" } }), res);

    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/No phone number resolved/);
    expect(mockSendSmsToAll).not.toHaveBeenCalled();
  });

  it("substitutes {{agent_phone_10}} with the 10-digit form (no +1) for star-code dial-strings", async () => {
    const star = {
      id: "verizon",
      label: "Verizon",
      message: "Tap to dial: *72{{agent_phone_10}} — full E.164 backup: {{agent_phone}}.",
    };
    mockGetClientDocument.mockResolvedValue({
      dispatch_text_numbers: ["+15551111111"],
      name: "Acme",
      outbound_from_number: "+18158804070",
    });
    mockGetSettings.mockResolvedValue({ setup_instructions: [star] });
    mockSendSmsToAll.mockResolvedValue(undefined);

    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "verizon" } }), res);

    expect(res._status).toBe(200);
    expect(mockSendSmsToAll).toHaveBeenCalledWith(
      ["+15551111111"],
      "Tap to dial: *728158804070 — full E.164 backup: +18158804070.",
    );
  });

  it("substitutes {{agent_phone_pretty}} with the (NNN) NNN-NNNN form for hosted-PBX UIs", async () => {
    const ringcentral = {
      id: "ringcentral",
      label: "RingCentral",
      message: "In RingCentral, set forwarding target to {{agent_phone_pretty}}.",
    };
    mockGetClientDocument.mockResolvedValue({
      dispatch_text_numbers: ["+15551111111"],
      name: "Acme",
      outbound_from_number: "+18158804070",
    });
    mockGetSettings.mockResolvedValue({ setup_instructions: [ringcentral] });
    mockSendSmsToAll.mockResolvedValue(undefined);

    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-instructions",
      makeReq({ params: { slug: "acme" }, body: { id: "ringcentral" } }), res);

    expect(res._status).toBe(200);
    expect(mockSendSmsToAll).toHaveBeenCalledWith(
      ["+15551111111"],
      "In RingCentral, set forwarding target to (815) 880-4070.",
    );
  });
});

describe("POST /agents/:slug/send-payment-link", () => {
  it("templates stripe_payment_url and sends", async () => {
    mockGetClientDocument.mockResolvedValue({ dispatch_text_numbers: ["+1"] });
    mockGetSettings.mockResolvedValue({
      stripe_payment_url: "https://pay/",
      payment_sms_message: "Pay: {{stripe_payment_url}}",
    });
    mockSendSmsToAll.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-payment-link",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    expect(mockSendSmsToAll).toHaveBeenCalledWith(["+1"], "Pay: https://pay/");
  });
});

describe("POST /agents/:slug/send-portal-link", () => {
  it("returns 400 when no portal token yet", async () => {
    mockGetClientDocument.mockResolvedValue({ dispatch_text_numbers: ["+1"] });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-portal-link",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/Portal link/);
  });

  it("templates the portal URL and sends", async () => {
    mockGetClientDocument.mockResolvedValue({
      portal_token: "tok",
      dispatch_text_numbers: ["+1"],
    });
    mockGetSettings.mockResolvedValue({ portal_sms_message: "P: {{portal_url}}" });
    mockSendSmsToAll.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/agents/:slug/send-portal-link",
      makeReq({ params: { slug: "acme" }, host: "app.x.com" }), res);
    expect(res._status).toBe(200);
    expect(mockSendSmsToAll).toHaveBeenCalledWith(["+1"], "P: https://app.x.com/portal/acme?token=tok");
  });
});

// ── Billing/COGS ───────────────────────────────────────────────────────────

describe("GET /billing/cogs/:slug", () => {
  it("clamps months to [1, 24]", async () => {
    mockGetClientCogs.mockResolvedValue({ months: [] });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/billing/cogs/:slug",
      makeReq({ params: { slug: "acme" }, query: { months: "100" } }), res);
    expect(mockGetClientCogs).toHaveBeenCalledWith("acme", 24);
  });

  it("defaults to 6 months when not provided", async () => {
    mockGetClientCogs.mockResolvedValue({ months: [] });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/billing/cogs/:slug",
      makeReq({ params: { slug: "acme" } }), res);
    expect(mockGetClientCogs).toHaveBeenCalledWith("acme", 6);
  });

  it("returns 500 when cogs query throws", async () => {
    mockGetClientCogs.mockRejectedValue(new Error("agg failed"));
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/billing/cogs/:slug",
      makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(500);
  });
});

// ── Settings ───────────────────────────────────────────────────────────────

describe("GET / PATCH /settings", () => {
  it("returns settings", async () => {
    mockGetSettings.mockResolvedValue({ google_review_url: "x" });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/settings", makeReq({}), res);
    expect(res._json).toEqual({ google_review_url: "x" });
  });

  it("updates settings and audits", async () => {
    mockUpdateSettings.mockResolvedValue({ updated: true });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "patch", "/settings",
      makeReq({ body: { foo: "bar" } }), res);
    expect(res._status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), "update_settings", "global", { fields: ["foo"] });
  });

  it("returns 500 when updateSettings throws", async () => {
    mockUpdateSettings.mockRejectedValue(new Error("validation"));
    const res = makeRes();
    await runRoute(dashboardApiRouter, "patch", "/settings", makeReq({ body: {} }), res);
    expect(res._status).toBe(500);
  });
});

// ── Blast SMS ──────────────────────────────────────────────────────────────

describe("POST /blast-sms/preview", () => {
  it("returns 400 when message missing", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/blast-sms/preview",
      makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns preview from previewBlast", async () => {
    mockPreviewBlast.mockReturnValue({ recipients: 5 });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/blast-sms/preview",
      makeReq({ body: { message: "hi" } }), res);
    expect(res._json).toEqual({ recipients: 5 });
  });
});

describe("POST /blast-sms", () => {
  it("returns 400 when message missing", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/blast-sms", makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when message exceeds 1600 chars", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/blast-sms",
      makeReq({ body: { message: "x".repeat(1601) } }), res);
    expect(res._status).toBe(400);
  });

  it("sends and audits", async () => {
    mockSendBlast.mockResolvedValue({ total_recipients: 5, total_clients: 2, sent: 5, failed: [] });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/blast-sms",
      makeReq({ body: { message: "hi all" } }), res);
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.sent).toBe(5);
    expect(mockLogAudit).toHaveBeenCalled();
  });
});

// ── Data point defaults ────────────────────────────────────────────────────

describe("GET /data-point-defaults", () => {
  it("merges category labels from settings on top of defaults", async () => {
    mockGetDataPointDefaultsWithCategory.mockResolvedValue([{ key: "x" }]);
    mockGetSettings.mockResolvedValue({
      category_order: ["B", "A"],
      category_labels: { A: "Custom A", B: "Custom B" },
    });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/data-point-defaults", makeReq({}), res);
    expect(res._json.categoryOrder).toEqual(["B", "A"]);
    expect(res._json.categoryLabels.A).toBe("Custom A");
  });

  it("falls back to baked-in CATEGORY_ORDER when settings has none", async () => {
    mockGetDataPointDefaultsWithCategory.mockResolvedValue([]);
    mockGetSettings.mockResolvedValue({});
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/data-point-defaults", makeReq({}), res);
    expect(res._json.categoryOrder).toEqual(["A", "B"]);
  });
});

describe("PATCH /data-point-defaults/:key", () => {
  it("returns 404 when not found", async () => {
    mockUpdateDataPointDefault.mockResolvedValue(null);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "patch", "/data-point-defaults/:key",
      makeReq({ params: { key: "missing" }, body: {} }), res);
    expect(res._status).toBe(404);
  });

  it("returns updated dp on success", async () => {
    mockUpdateDataPointDefault.mockResolvedValue({ key: "k", label: "L" });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "patch", "/data-point-defaults/:key",
      makeReq({ params: { key: "k" }, body: { label: "L" } }), res);
    expect(res._json.dataPoint.label).toBe("L");
  });
});

describe("POST /data-point-defaults", () => {
  it("returns 400 when key/label missing", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/data-point-defaults",
      makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("creates dp and audits", async () => {
    mockCreateDataPointDefault.mockResolvedValue({ key: "new" });
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/data-point-defaults",
      makeReq({ body: { key: "new", label: "New", type: "string" } }), res);
    expect(res._json.success).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), "create_data_point", "new");
  });

  it("returns 400 when create throws", async () => {
    mockCreateDataPointDefault.mockRejectedValue(new Error("dupe"));
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/data-point-defaults",
      makeReq({ body: { key: "k", label: "L" } }), res);
    expect(res._status).toBe(400);
  });
});

describe("PUT /data-point-defaults/reorder", () => {
  it("returns 400 when items not array", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "put", "/data-point-defaults/reorder",
      makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("reorders successfully", async () => {
    mockReorderDataPointDefaults.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "put", "/data-point-defaults/reorder",
      makeReq({ body: { items: [{ key: "a" }, { key: "b" }] } }), res);
    expect(res._json.success).toBe(true);
  });
});

describe("DELETE /data-point-defaults/:key", () => {
  it("returns 404 when not found", async () => {
    mockDeleteDataPointDefault.mockResolvedValue(false);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "delete", "/data-point-defaults/:key",
      makeReq({ params: { key: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("deletes and audits", async () => {
    mockDeleteDataPointDefault.mockResolvedValue(true);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "delete", "/data-point-defaults/:key",
      makeReq({ params: { key: "x" } }), res);
    expect(res._json.success).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), "delete_data_point", "x");
  });
});

// ── Users ──────────────────────────────────────────────────────────────────

describe("GET /users", () => {
  it("returns user list", async () => {
    mockListUsers.mockResolvedValue([{ username: "alice" }]);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "get", "/users", makeReq({}), res);
    expect(res._json).toEqual([{ username: "alice" }]);
  });
});

describe("POST /users", () => {
  it("returns 400 when username/password missing", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/users",
      makeReq({ body: {}, user: { username: "admin" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 for invalid username characters", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/users",
      makeReq({
        body: { username: "Bad-Name", password: "secret123", role: "admin" },
        user: { username: "admin" },
      }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 for short password", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/users",
      makeReq({
        body: { username: "alice", password: "x", role: "admin" },
        user: { username: "admin" },
      }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 for invalid role", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/users",
      makeReq({
        body: { username: "alice", password: "secret123", role: "godmode" },
        user: { username: "admin" },
      }), res);
    expect(res._status).toBe(400);
  });

  it("creates user and audits", async () => {
    mockCreateUser.mockResolvedValue(undefined);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/users",
      makeReq({
        body: { username: "alice", password: "secret123", role: "operator" },
        user: { username: "admin" },
      }), res);
    expect(res._json.success).toBe(true);
    expect(mockCreateUser).toHaveBeenCalledWith("alice", "secret123", "operator", "admin", undefined);
  });

  it("returns 400 when createUser throws (e.g. duplicate)", async () => {
    mockCreateUser.mockRejectedValue(new Error("already exists"));
    const res = makeRes();
    await runRoute(dashboardApiRouter, "post", "/users",
      makeReq({
        body: { username: "alice", password: "secret123", role: "viewer" },
        user: { username: "admin" },
      }), res);
    expect(res._status).toBe(400);
  });
});

describe("PATCH /users/:username/permissions", () => {
  it("returns 400 when permissions object missing", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "patch", "/users/:username/permissions",
      makeReq({ params: { username: "alice" }, body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when user not found", async () => {
    mockUpdateUserPermissions.mockResolvedValue(false);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "patch", "/users/:username/permissions",
      makeReq({ params: { username: "alice" }, body: { permissions: { x: true } } }), res);
    expect(res._status).toBe(404);
  });

  it("updates and audits", async () => {
    mockUpdateUserPermissions.mockResolvedValue(true);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "patch", "/users/:username/permissions",
      makeReq({ params: { username: "alice" }, body: { permissions: { x: true } } }), res);
    expect(res._json.success).toBe(true);
    expect(mockLogAudit).toHaveBeenCalled();
  });
});

describe("DELETE /users/:username", () => {
  it("returns 400 when deleting self", async () => {
    const res = makeRes();
    await runRoute(dashboardApiRouter, "delete", "/users/:username",
      makeReq({ params: { username: "admin" }, user: { username: "admin" } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when user not found", async () => {
    mockDeleteUser.mockResolvedValue(false);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "delete", "/users/:username",
      makeReq({ params: { username: "ghost" }, user: { username: "admin" } }), res);
    expect(res._status).toBe(404);
  });

  it("deletes and audits", async () => {
    mockDeleteUser.mockResolvedValue(true);
    const res = makeRes();
    await runRoute(dashboardApiRouter, "delete", "/users/:username",
      makeReq({ params: { username: "alice" }, user: { username: "admin" } }), res);
    expect(res._json.success).toBe(true);
    expect(mockLogAudit).toHaveBeenCalled();
  });
});

// ── Backup ─────────────────────────────────────────────────────────────────

describe("POST / (backup)", () => {
  it("returns 200 with key on success", async () => {
    mockRunBackup.mockResolvedValue({ success: true, key: "backup-2026.json" });
    const res = makeRes();
    await runRoute(backupRouter, "post", "/", makeReq({}), res);
    expect(res._json).toEqual({ success: true, key: "backup-2026.json" });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), "trigger_backup", "manual");
  });

  it("returns 500 on backup failure", async () => {
    mockRunBackup.mockResolvedValue({ success: false, error: "s3 down" });
    const res = makeRes();
    await runRoute(backupRouter, "post", "/", makeReq({}), res);
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ success: false, error: "s3 down" });
  });
});
