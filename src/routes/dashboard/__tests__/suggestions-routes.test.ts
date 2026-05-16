// Coverage for the dashboard suggestions HTTP surface (routes/dashboard/suggestions.ts).
// The file orchestrates: list / detail / approve / reject / edit / manual
// analyze, plus the bubble-up-to-draft path. None of it had route-level
// tests before this file; the only adjacent coverage was unit tests on
// the underlying applier/draft-applier libraries.
//
// Strategy mirrors permission-gates.test.ts: mock every collaborator,
// import the router, walk the route stack manually with a forged
// `req.user` and a stub `res`. We never touch Mongo / Retell / Anthropic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { ObjectId } from "mongodb";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const {
  mockGetSuggestion, mockListSuggestions, mockUpdateSuggestion,
  mockGetClientDocument,
  mockBuildPublishPayload, mockBuildSnapshotFromCanonical,
  mockApplyToDraft,
  mockSaveAndPublishHandler,
  mockRollbackToVersionHandler,
  mockGetLatestVersion,
  mockGetPreviousVersion,
  mockGetFindingRateMetrics,
  mockLoadDraft, mockUpdateDraftExportConfig,
  mockAnalyzeAndPersist,
  mockLogAudit,
  mockRetellRetrieve,
} = vi.hoisted(() => ({
  mockGetSuggestion: vi.fn(),
  mockListSuggestions: vi.fn(),
  mockUpdateSuggestion: vi.fn(),
  mockGetClientDocument: vi.fn(),
  mockBuildPublishPayload: vi.fn(),
  mockBuildSnapshotFromCanonical: vi.fn(() => ({ paths: [] })),
  mockApplyToDraft: vi.fn(),
  mockSaveAndPublishHandler: vi.fn(),
  mockRollbackToVersionHandler: vi.fn(),
  mockGetLatestVersion: vi.fn(),
  mockGetPreviousVersion: vi.fn(),
  mockGetFindingRateMetrics: vi.fn(),
  mockLoadDraft: vi.fn(),
  mockUpdateDraftExportConfig: vi.fn(),
  mockAnalyzeAndPersist: vi.fn(),
  mockLogAudit: vi.fn(),
  mockRetellRetrieve: vi.fn(),
}));

vi.mock("../../../config.js", () => ({
  config: { RETELL_API_KEY: "k", API_KEY: "internal" },
}));

vi.mock("retell-sdk", () => ({
  default: class {
    call = { retrieve: (...a: unknown[]) => mockRetellRetrieve(...a) };
  },
}));

vi.mock("../../../lib/improvement-suggestions.js", () => ({
  getSuggestion: (...a: unknown[]) => mockGetSuggestion(...a),
  listSuggestions: (...a: unknown[]) => mockListSuggestions(...a),
  updateSuggestion: (...a: unknown[]) => mockUpdateSuggestion(...a),
}));

vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: (...a: unknown[]) => mockGetClientDocument(...a),
}));

vi.mock("../../../lib/suggestion-applier.js", () => ({
  buildPublishPayload: (...a: unknown[]) => mockBuildPublishPayload(...a),
  buildSnapshotFromCanonical: (...a: unknown[]) => (mockBuildSnapshotFromCanonical as any)(...a),
}));

vi.mock("../../../lib/draft-applier.js", () => ({
  applyToDraft: (...a: unknown[]) => mockApplyToDraft(...a),
}));

vi.mock("../node-editor.js", () => ({
  saveAndPublishHandler: (...a: unknown[]) => mockSaveAndPublishHandler(...a),
  rollbackToVersionHandler: (...a: unknown[]) => mockRollbackToVersionHandler(...a),
}));

vi.mock("../../../lib/agent-versions.js", () => ({
  getLatestVersion: (...a: unknown[]) => mockGetLatestVersion(...a),
  getPreviousVersion: (...a: unknown[]) => mockGetPreviousVersion(...a),
}));

vi.mock("../../../lib/finding-rates.js", () => ({
  getFindingRateMetrics: (...a: unknown[]) => mockGetFindingRateMetrics(...a),
}));

vi.mock("../../../lib/agent-from-draft.js", () => ({
  loadDraft: (...a: unknown[]) => mockLoadDraft(...a),
  updateDraftExportConfig: (...a: unknown[]) => mockUpdateDraftExportConfig(...a),
}));

vi.mock("../../../lib/transcript-review.js", () => ({
  analyzeAndPersist: (...a: unknown[]) => mockAnalyzeAndPersist(...a),
}));

vi.mock("../../../lib/audit.js", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

// Pull the router AFTER mocks are registered.
const { suggestionsRouter } = await import("../suggestions.js");

// ── Test harness ────────────────────────────────────────────────────────────

interface TestUser {
  username: string;
  role: "viewer" | "operator" | "admin" | "super_admin";
  permissions: Record<string, boolean>;
  featurePermissions: Record<string, "none" | "read" | "write" | "manage">;
  isRoot: boolean;
}

function userWith(featureLevel: "none" | "read" | "write" | "manage", isRoot = false): TestUser {
  return {
    username: `op-${featureLevel}`,
    role: "admin",
    permissions: {},
    featurePermissions: { transcript_review: featureLevel },
    isRoot,
  };
}

function makeRes() {
  const res: any = { _status: 200, _json: null, _ended: false };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: unknown) => { res._json = data; res._ended = true; return res; };
  return res;
}

function makeReq(opts: {
  user?: TestUser;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
} = {}): Request {
  return {
    user: opts.user ?? userWith("write"),
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
    headers: {},
    get: () => undefined,
  } as unknown as Request;
}

function findRouteStack(method: string, path: string): unknown[] {
  for (const layer of (suggestionsRouter as any).stack) {
    if (!layer.route) continue;
    if (layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack;
    }
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

async function runRoute(method: string, path: string, req: Request, res: Response): Promise<void> {
  const stack = findRouteStack(method, path);
  for (let i = 0; i < stack.length; i++) {
    let advance = false;
    let nextErr: unknown = null;
    const next = (err?: unknown) => { if (err) nextErr = err; advance = true; };
    const result = (stack[i] as any).handle(req, res, next);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
    if (nextErr) throw nextErr;
    if ((res as any)._ended || !advance) return;
  }
}

// ── Common fixtures ─────────────────────────────────────────────────────────

const VALID_ID = new ObjectId().toString();

function suggestionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: VALID_ID,
    agent_id: "agent_1",
    client_slug: "acme",
    finding_ids: [],
    type: "unanswered_question",
    severity: "high",
    scope: "agent",
    scope_target: "agent_1",
    status: "pending",
    proposed_change: {
      kind: "add_faq_entry",
      payload: { entry: "After hours: $50 trip charge." },
      diff_preview: { component_kind: "faq_knowledge_base", component_label: "FAQ", before: "—", after: "..." },
    },
    excerpt: "snippet",
    description: "agent dodged the question",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function clientDoc(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme",
    agent_id: "agent_1",
    source_draft: "HVAC",
    retell_agents: { agent_1: { conversationFlow: { /* opaque to mocked applier */ } } },
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of [
    mockGetSuggestion, mockListSuggestions, mockUpdateSuggestion,
    mockGetClientDocument, mockBuildPublishPayload, mockBuildSnapshotFromCanonical,
    mockApplyToDraft, mockSaveAndPublishHandler, mockRollbackToVersionHandler,
    mockGetLatestVersion, mockGetPreviousVersion, mockGetFindingRateMetrics,
    mockLoadDraft, mockUpdateDraftExportConfig, mockAnalyzeAndPersist,
    mockLogAudit, mockRetellRetrieve,
  ]) m.mockReset();

  mockBuildSnapshotFromCanonical.mockReturnValue({ paths: [] });
  mockUpdateSuggestion.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
    suggestionDoc(patch),
  );
  // Make saveAndPublishHandler succeed by default — routes call it via the
  // captured-response shim, so it should "respond" by setting status/json.
  mockSaveAndPublishHandler.mockImplementation(async (_req: any, res: any) => {
    res.status(200).json({ success: true });
  });
  mockRollbackToVersionHandler.mockImplementation(async (_req: any, res: any) => {
    res.status(200).json({ success: true, restoredVersion: 7 });
  });
});

// ── GET /agents/:slug/suggestions (list with bubble_up envelope) ────────────

describe("GET /agents/:slug/suggestions", () => {
  it("returns suggestions with bubble_up={eligible:true} when draft has exportConfig", async () => {
    mockListSuggestions.mockResolvedValue([suggestionDoc()]);
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockLoadDraft.mockResolvedValue({
      name: "HVAC",
      exportConfig: { business: { businessName: "x" }, client: { slug: "x", dispatch_text_numbers: [] } },
    });

    const req = makeReq({ user: userWith("read"), params: { slug: "acme" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/suggestions", req, res);

    expect(res._status).toBe(200);
    expect(res._json.suggestions).toHaveLength(1);
    expect(res._json.bubble_up).toEqual({ eligible: true, source_draft: "HVAC" });
  });

  it("returns reason=draft_lacks_export_config when draft has no exportConfig", async () => {
    mockListSuggestions.mockResolvedValue([]);
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockLoadDraft.mockResolvedValue({ name: "HVAC" });

    const req = makeReq({ user: userWith("read"), params: { slug: "acme" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/suggestions", req, res);
    expect(res._json.bubble_up.reason).toBe("draft_lacks_export_config");
  });

  it("returns reason=no_source_draft when client has no source_draft", async () => {
    mockListSuggestions.mockResolvedValue([]);
    mockGetClientDocument.mockResolvedValue(clientDoc({ source_draft: undefined }));

    const req = makeReq({ user: userWith("read"), params: { slug: "acme" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/suggestions", req, res);
    expect(res._json.bubble_up.reason).toBe("no_source_draft");
  });

  it("403s when user lacks transcript_review:read", async () => {
    const req = makeReq({ user: userWith("none"), params: { slug: "acme" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/suggestions", req, res);
    expect(res._status).toBe(403);
    expect(mockListSuggestions).not.toHaveBeenCalled();
  });
});

// ── GET /suggestions/:id ────────────────────────────────────────────────────

describe("GET /suggestions/:id", () => {
  it("returns 400 for invalid ObjectId", async () => {
    const req = makeReq({ user: userWith("read"), params: { id: "not-an-id" } });
    const res = makeRes();
    await runRoute("get", "/suggestions/:id", req, res);
    expect(res._status).toBe(400);
  });

  it("returns 404 when not found", async () => {
    mockGetSuggestion.mockResolvedValue(null);
    const req = makeReq({ user: userWith("read"), params: { id: VALID_ID } });
    const res = makeRes();
    await runRoute("get", "/suggestions/:id", req, res);
    expect(res._status).toBe(404);
  });

  it("returns the suggestion when found", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    const req = makeReq({ user: userWith("read"), params: { id: VALID_ID } });
    const res = makeRes();
    await runRoute("get", "/suggestions/:id", req, res);
    expect(res._status).toBe(200);
    expect(res._json.suggestion._id).toBe(VALID_ID);
  });
});

// ── POST /suggestions/:id/approve (the load-bearing one) ───────────────────

describe("POST /suggestions/:id/approve", () => {
  beforeEach(() => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockGetLatestVersion.mockResolvedValue({ _id: { toString: () => "ver-1" } });
  });

  it("forwards to save-and-publish, then marks the suggestion applied", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    mockBuildPublishPayload.mockReturnValue({
      ok: true,
      payload: { changes: { faqKnowledgeBase: "merged" } },
      description: "Add FAQ entry: …",
      diff_preview: { component_kind: "faq_knowledge_base", component_label: "FAQ", before: "x", after: "y" },
    });

    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.version_id).toBe("ver-1");
    expect(mockSaveAndPublishHandler).toHaveBeenCalledOnce();
    // The proxyReq should carry the slug/agentId derived from the suggestion.
    const proxyReq = mockSaveAndPublishHandler.mock.calls[0][0];
    expect(proxyReq.params).toEqual({ slug: "acme", agentId: "agent_1" });
    expect(proxyReq.body).toEqual({ changes: { faqKnowledgeBase: "merged" } });

    // updateSuggestion called with status applied + applied_version_id.
    expect(mockUpdateSuggestion).toHaveBeenCalledOnce();
    const [, patch] = mockUpdateSuggestion.mock.calls[0];
    expect(patch.status).toBe("applied");
    expect(patch.applied_version_id).toBe("ver-1");
  });

  it("returns 400 when applier rejects with a non-advisory error", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    mockBuildPublishPayload.mockReturnValue({ ok: false, error: "FAQ already contains this entry." });

    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._status).toBe(400);
    expect(mockSaveAndPublishHandler).not.toHaveBeenCalled();
    expect(mockUpdateSuggestion).not.toHaveBeenCalled();
  });

  it("marks advisory-only suggestions as applied and returns advisory:true", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc({
      proposed_change: {
        kind: "edit_router_branch",
        target_path_name: "x",
        payload: { note: "manual" },
        diff_preview: { component_kind: "transition_condition", component_label: "x", before: "", after: "" },
      },
    }));
    mockBuildPublishPayload.mockReturnValue({
      ok: false,
      advisoryOnly: true,
      error: "Router branch conditions require manual review.",
    });

    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._status).toBe(200);
    expect(res._json.advisory).toBe(true);
    expect(mockSaveAndPublishHandler).not.toHaveBeenCalled();
    const [, patch] = mockUpdateSuggestion.mock.calls[0];
    expect(patch.status).toBe("applied");
    expect(patch.decision_note).toMatch(/^advisory:/);
  });

  it("returns 409 when the suggestion is already applied/rejected", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc({ status: "applied" }));
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);
    expect(res._status).toBe(409);
  });

  it("forwards save-and-publish errors verbatim and leaves suggestion pending", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    mockBuildPublishPayload.mockReturnValue({
      ok: true,
      payload: { changes: {} },
      description: "x",
      diff_preview: { component_kind: "faq_knowledge_base", component_label: "FAQ", before: "", after: "" },
    });
    mockSaveAndPublishHandler.mockImplementation(async (_req: any, res: any) => {
      res.status(400).json({ error: "Validation failed", errors: ["bad"] });
    });

    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._status).toBe(400);
    expect(res._json.error).toBe("Validation failed");
    // Status stays pending — updateSuggestion is NOT called.
    expect(mockUpdateSuggestion).not.toHaveBeenCalled();
  });

  it("rejects scope!=agent (only agent-scoped suggestions auto-apply)", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc({ scope: "draft", scope_target: "HVAC" }));
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/agent-scoped/);
  });

  // ── bubble-up to draft ────────────────────────────────────────────────────

  it("propagates to the draft when scope=agent_and_draft AND lineage qualifies", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    mockBuildPublishPayload.mockReturnValue({
      ok: true,
      payload: { changes: {} },
      description: "Add FAQ entry to agent",
      diff_preview: { component_kind: "faq_knowledge_base", component_label: "FAQ", before: "", after: "" },
    });
    mockLoadDraft.mockResolvedValue({
      name: "HVAC",
      exportConfig: { business: { businessName: "x" }, client: { slug: "x", dispatch_text_numbers: [] } },
    });
    mockApplyToDraft.mockReturnValue({ ok: true, next: { /* mutated */ }, description: "Append FAQ to draft" });
    mockUpdateDraftExportConfig.mockResolvedValue(true);

    const req = makeReq({ params: { id: VALID_ID }, body: { scope: "agent_and_draft" } });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._json.draft_propagation).toEqual({
      ok: true,
      draftName: "HVAC",
      description: "Append FAQ to draft",
    });
    // decision_note should reflect the bubbled-up description.
    const [, patch] = mockUpdateSuggestion.mock.calls[0];
    expect(patch.decision_note).toMatch(/also:/);
  });

  it("does not fail the approve when bubble-up draft is missing — returns ok:false in draft_propagation", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    mockBuildPublishPayload.mockReturnValue({
      ok: true,
      payload: { changes: {} },
      description: "x",
      diff_preview: { component_kind: "faq_knowledge_base", component_label: "FAQ", before: "", after: "" },
    });
    mockLoadDraft.mockResolvedValue(null);

    const req = makeReq({ params: { id: VALID_ID }, body: { scope: "agent_and_draft" } });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.draft_propagation.ok).toBe(false);
    expect(res._json.draft_propagation.reason).toMatch(/not found/);
  });

  it("does not fail the approve when applyToDraft returns ok:false (e.g. not propagatable)", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    mockBuildPublishPayload.mockReturnValue({
      ok: true,
      payload: { changes: {} },
      description: "x",
      diff_preview: { component_kind: "faq_knowledge_base", component_label: "FAQ", before: "", after: "" },
    });
    mockLoadDraft.mockResolvedValue({
      name: "HVAC",
      exportConfig: { business: { businessName: "x" } },
    });
    mockApplyToDraft.mockReturnValue({
      ok: false,
      notPropagatable: true,
      error: "Collect-prompt edits don't propagate.",
    });

    const req = makeReq({ params: { id: VALID_ID }, body: { scope: "agent_and_draft" } });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._status).toBe(200);
    expect(res._json.draft_propagation.ok).toBe(false);
    expect(mockUpdateDraftExportConfig).not.toHaveBeenCalled();
  });

  it("does NOT call bubble-up when scope is agent (default)", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    mockBuildPublishPayload.mockReturnValue({
      ok: true,
      payload: { changes: {} },
      description: "x",
      diff_preview: { component_kind: "faq_knowledge_base", component_label: "FAQ", before: "", after: "" },
    });

    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);

    expect(res._json.draft_propagation).toBeNull();
    expect(mockApplyToDraft).not.toHaveBeenCalled();
    expect(mockLoadDraft).not.toHaveBeenCalled();
  });

  it("403s when user lacks transcript_review:write", async () => {
    const req = makeReq({ user: userWith("read"), params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/approve", req, res);
    expect(res._status).toBe(403);
    expect(mockGetSuggestion).not.toHaveBeenCalled();
  });
});

// ── POST /suggestions/:id/reject ────────────────────────────────────────────

describe("POST /suggestions/:id/reject", () => {
  it("flips status to rejected with the operator's note", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
    const req = makeReq({ params: { id: VALID_ID }, body: { note: "  duplicate  " } });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/reject", req, res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    const [, patch] = mockUpdateSuggestion.mock.calls[0];
    expect(patch.status).toBe("rejected");
    expect(patch.decision_note).toBe("duplicate");
  });

  it("returns 409 when already decided", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc({ status: "rejected" }));
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/reject", req, res);
    expect(res._status).toBe(409);
  });
});

// ── POST /agents/:slug/calls/:callId/analyze ────────────────────────────────

describe("POST /agents/:slug/calls/:callId/analyze", () => {
  beforeEach(() => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockRetellRetrieve.mockResolvedValue({
      transcript: "user said something.",
      transcript_object: [],
      collected_dynamic_variables: {},
      retell_llm_dynamic_variables: {},
      disconnection_reason: "user_hangup",
      duration_ms: 30_000,
    });
  });

  it("fetches the call from Retell and forwards to analyzeAndPersist", async () => {
    mockAnalyzeAndPersist.mockResolvedValue({ ok: true, suggestionsCreated: 2, suggestionIds: ["a", "b"] });

    const req = makeReq({ params: { slug: "acme", callId: "call_xyz" }, body: {} });
    const res = makeRes();
    await runRoute("post", "/agents/:slug/calls/:callId/analyze", req, res);

    expect(res._status).toBe(200);
    expect(res._json.suggestions_created).toBe(2);
    expect(res._json.suggestion_ids).toEqual(["a", "b"]);

    const args = mockAnalyzeAndPersist.mock.calls[0][0];
    expect(args.callId).toBe("call_xyz");
    expect(args.agentId).toBe("agent_1");
    expect(args.clientSlug).toBe("acme");
    expect(args.canonicalJson).toBeDefined();
    expect(args.call.transcript).toBe("user said something.");
  });

  it("returns 502 when Retell retrieve throws (does not call analyzer)", async () => {
    mockRetellRetrieve.mockRejectedValue(new Error("retell down"));
    const req = makeReq({ params: { slug: "acme", callId: "call_xyz" }, body: {} });
    const res = makeRes();
    await runRoute("post", "/agents/:slug/calls/:callId/analyze", req, res);
    expect(res._status).toBe(502);
    expect(mockAnalyzeAndPersist).not.toHaveBeenCalled();
  });

  it("returns 404 when the slug is unknown", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const req = makeReq({ params: { slug: "ghost", callId: "call_xyz" }, body: {} });
    const res = makeRes();
    await runRoute("post", "/agents/:slug/calls/:callId/analyze", req, res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when the client has no agent_id", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc({ agent_id: undefined }));
    const req = makeReq({ params: { slug: "acme", callId: "call_xyz" }, body: {} });
    const res = makeRes();
    await runRoute("post", "/agents/:slug/calls/:callId/analyze", req, res);
    expect(res._status).toBe(400);
  });

  it("returns 500 when analyzeAndPersist returns ok:false", async () => {
    mockAnalyzeAndPersist.mockResolvedValue({ ok: false, error: "Anthropic timeout" });
    const req = makeReq({ params: { slug: "acme", callId: "call_xyz" }, body: {} });
    const res = makeRes();
    await runRoute("post", "/agents/:slug/calls/:callId/analyze", req, res);
    expect(res._status).toBe(500);
    expect(res._json.error).toBe("Anthropic timeout");
  });
});

// ── POST /suggestions/:id/edit ──────────────────────────────────────────────

describe("POST /suggestions/:id/edit", () => {
  beforeEach(() => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc());
  });

  it("updates the proposed_change payload, locking the kind", async () => {
    const req = makeReq({
      params: { id: VALID_ID },
      body: { proposed_change: { payload: { entry: "edited entry" } } },
    });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/edit", req, res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    const [, patch] = mockUpdateSuggestion.mock.calls[0];
    expect(patch.proposed_change.kind).toBe("add_faq_entry"); // locked
    expect(patch.proposed_change.payload).toEqual({ entry: "edited entry" });
  });

  it("rejects an attempt to change kind", async () => {
    const req = makeReq({
      params: { id: VALID_ID },
      body: { proposed_change: { kind: "edit_global_prompt", payload: { append: "x" } } },
    });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/edit", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/Cannot change.*kind/);
    expect(mockUpdateSuggestion).not.toHaveBeenCalled();
  });

  it("returns 400 when proposed_change is missing", async () => {
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/edit", req, res);
    expect(res._status).toBe(400);
  });

  it("returns 409 when the suggestion is no longer pending", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc({ status: "applied" }));
    const req = makeReq({
      params: { id: VALID_ID },
      body: { proposed_change: { payload: { entry: "x" } } },
    });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/edit", req, res);
    expect(res._status).toBe(409);
  });
});

// ── GET /suggestions (cross-agent inbox) ────────────────────────────────────

describe("GET /suggestions (inbox)", () => {
  it("defaults to status=pending with limit/offset clamped", async () => {
    mockListSuggestions.mockResolvedValue([]);
    const req = makeReq({
      user: userWith("read"),
      query: { limit: "9999", offset: "-5" },
    });
    const res = makeRes();
    await runRoute("get", "/suggestions", req, res);
    expect(res._status).toBe(200);
    expect(mockListSuggestions).toHaveBeenCalledOnce();
    const opts = mockListSuggestions.mock.calls[0][0];
    expect(opts.status).toBe("pending");
    expect(opts.limit).toBe(200); // clamped to max
    expect(opts.offset).toBe(0); // clamped to min
  });

  it("filters by query status when valid", async () => {
    mockListSuggestions.mockResolvedValue([]);
    const req = makeReq({ user: userWith("read"), query: { status: "applied" } });
    const res = makeRes();
    await runRoute("get", "/suggestions", req, res);
    expect(mockListSuggestions.mock.calls[0][0].status).toBe("applied");
  });

  it("ignores an unknown status value (falls back to default pending)", async () => {
    mockListSuggestions.mockResolvedValue([]);
    const req = makeReq({ user: userWith("read"), query: { status: "garbage" } });
    const res = makeRes();
    await runRoute("get", "/suggestions", req, res);
    expect(mockListSuggestions.mock.calls[0][0].status).toBe("pending");
  });

  it("accepts rolled_back as a status filter", async () => {
    mockListSuggestions.mockResolvedValue([]);
    const req = makeReq({ user: userWith("read"), query: { status: "rolled_back" } });
    const res = makeRes();
    await runRoute("get", "/suggestions", req, res);
    expect(mockListSuggestions.mock.calls[0][0].status).toBe("rolled_back");
  });
});

// ── POST /suggestions/:id/rollback ──────────────────────────────────────────

describe("POST /suggestions/:id/rollback", () => {
  const PREV_VERSION_ID = new ObjectId().toString();
  const APPLIED_VERSION_ID = new ObjectId().toString();

  it("delegates to rollbackToVersionHandler and marks the suggestion rolled_back", async () => {
    mockGetSuggestion.mockResolvedValue(
      suggestionDoc({ status: "applied", applied_version_id: APPLIED_VERSION_ID }),
    );
    mockGetPreviousVersion.mockResolvedValue({
      _id: new ObjectId(PREV_VERSION_ID),
      version: 7,
      slug: "acme",
      agentId: "agent_1",
    });

    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);

    expect(res._status).toBe(200);
    expect(mockGetPreviousVersion).toHaveBeenCalledWith(APPLIED_VERSION_ID);
    // Should have invoked the rollback handler with the prior version id.
    expect(mockRollbackToVersionHandler).toHaveBeenCalledTimes(1);
    const proxyReq = mockRollbackToVersionHandler.mock.calls[0][0];
    expect(proxyReq.params).toEqual({ slug: "acme", agentId: "agent_1" });
    expect(proxyReq.body).toEqual({ versionId: PREV_VERSION_ID });
    // Suggestion patched to rolled_back with the restored version id.
    const patch = mockUpdateSuggestion.mock.calls.at(-1)![1];
    expect(patch.status).toBe("rolled_back");
    expect(patch.rolled_back_to_version_id).toBe(PREV_VERSION_ID);
    expect(res._json.restored_version).toBe(7);
  });

  it("rejects with 409 when the suggestion isn't applied", async () => {
    mockGetSuggestion.mockResolvedValue(suggestionDoc({ status: "pending" }));
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);
    expect(res._status).toBe(409);
    expect(mockRollbackToVersionHandler).not.toHaveBeenCalled();
  });

  it("rejects with 400 when applied_version_id is missing (advisory approval)", async () => {
    mockGetSuggestion.mockResolvedValue(
      suggestionDoc({ status: "applied", applied_version_id: undefined }),
    );
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/applied_version_id/);
    expect(mockRollbackToVersionHandler).not.toHaveBeenCalled();
  });

  it("rejects with 400 when there is no prior version (first publish)", async () => {
    mockGetSuggestion.mockResolvedValue(
      suggestionDoc({ status: "applied", applied_version_id: APPLIED_VERSION_ID }),
    );
    mockGetPreviousVersion.mockResolvedValue(null);
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/No prior version/);
    expect(mockRollbackToVersionHandler).not.toHaveBeenCalled();
    expect(mockUpdateSuggestion).not.toHaveBeenCalled();
  });

  it("propagates failures from the delegated rollback and does not flip status", async () => {
    mockGetSuggestion.mockResolvedValue(
      suggestionDoc({ status: "applied", applied_version_id: APPLIED_VERSION_ID }),
    );
    mockGetPreviousVersion.mockResolvedValue({
      _id: new ObjectId(PREV_VERSION_ID),
      version: 7, slug: "acme", agentId: "agent_1",
    });
    mockRollbackToVersionHandler.mockImplementation(async (_req: any, r: any) => {
      r.status(500).json({ error: "Retell push failed" });
    });

    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);
    expect(res._status).toBe(500);
    expect(mockUpdateSuggestion).not.toHaveBeenCalled();
  });

  it("returns 404 when the suggestion does not exist", async () => {
    mockGetSuggestion.mockResolvedValue(null);
    const req = makeReq({ params: { id: VALID_ID }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);
    expect(res._status).toBe(404);
  });

  it("rejects an invalid suggestion id with 400", async () => {
    const req = makeReq({ params: { id: "not-an-objectid" }, body: {} });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);
    expect(res._status).toBe(400);
    expect(mockGetSuggestion).not.toHaveBeenCalled();
  });

  it("requires transcript_review:write (forbids read-only operator)", async () => {
    const req = makeReq({
      user: userWith("read"),
      params: { id: VALID_ID },
      body: {},
    });
    const res = makeRes();
    await runRoute("post", "/suggestions/:id/rollback", req, res);
    expect(res._status).toBe(403);
  });
});

// ── GET /agents/:slug/finding-rates ─────────────────────────────────────────

describe("GET /agents/:slug/finding-rates", () => {
  it("returns metrics with the agent's resolved id and default 8 weeks", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockGetFindingRateMetrics.mockResolvedValue({
      agent_id: "agent_1", weeks: 8, window_start: "2026-03-15T00:00:00.000Z",
      buckets: [], totals: { calls: 0, by_type: {} },
    });

    const req = makeReq({ user: userWith("read"), params: { slug: "acme" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/finding-rates", req, res);

    expect(res._status).toBe(200);
    expect(mockGetFindingRateMetrics).toHaveBeenCalledWith("agent_1", 8);
    expect(res._json.metrics.agent_id).toBe("agent_1");
  });

  it("clamps the weeks query param to 1..12", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockGetFindingRateMetrics.mockResolvedValue({
      agent_id: "agent_1", weeks: 12, window_start: "2026-02-15T00:00:00.000Z",
      buckets: [], totals: { calls: 0, by_type: {} },
    });

    const req = makeReq({ user: userWith("read"), params: { slug: "acme" }, query: { weeks: "999" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/finding-rates", req, res);
    expect(mockGetFindingRateMetrics).toHaveBeenCalledWith("agent_1", 12);
  });

  it("404s when the client doesn't exist", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const req = makeReq({ user: userWith("read"), params: { slug: "missing" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/finding-rates", req, res);
    expect(res._status).toBe(404);
    expect(mockGetFindingRateMetrics).not.toHaveBeenCalled();
  });

  it("400s when the client has no agent_id", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc({ agent_id: undefined }));
    const req = makeReq({ user: userWith("read"), params: { slug: "acme" } });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/finding-rates", req, res);
    expect(res._status).toBe(400);
    expect(mockGetFindingRateMetrics).not.toHaveBeenCalled();
  });

  it("403s when the user lacks transcript_review:read", async () => {
    const req = makeReq({
      user: userWith("none"),
      params: { slug: "acme" },
    });
    const res = makeRes();
    await runRoute("get", "/agents/:slug/finding-rates", req, res);
    expect(res._status).toBe(403);
  });
});
