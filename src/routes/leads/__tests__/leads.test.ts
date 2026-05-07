import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const {
  mockCreatePendingLead,
  mockListPendingLeads,
  mockGetPendingLead,
  mockUpdatePendingLead,
  mockMarkPromoted,
  mockMarkDismissed,
  mockEnrichLead,
  mockLoadDraft,
  mockApplyOverrides,
  mockCreateAgentFromConfig,
  mockRequirePermission,
  mockGetSettings,
} = vi.hoisted(() => ({
  mockCreatePendingLead: vi.fn(),
  mockListPendingLeads: vi.fn(),
  mockGetPendingLead: vi.fn(),
  mockUpdatePendingLead: vi.fn(),
  mockMarkPromoted: vi.fn(),
  mockMarkDismissed: vi.fn(),
  mockEnrichLead: vi.fn(),
  mockLoadDraft: vi.fn(),
  mockApplyOverrides: vi.fn(),
  mockCreateAgentFromConfig: vi.fn(),
  mockRequirePermission: vi.fn(),
  mockGetSettings: vi.fn(),
}));

vi.mock("../../../lib/pending-leads.js", () => ({
  createPendingLead: (...a: any[]) => mockCreatePendingLead(...a),
  listPendingLeads: (...a: any[]) => mockListPendingLeads(...a),
  getPendingLead: (...a: any[]) => mockGetPendingLead(...a),
  updatePendingLead: (...a: any[]) => mockUpdatePendingLead(...a),
  markPromoted: (...a: any[]) => mockMarkPromoted(...a),
  markDismissed: (...a: any[]) => mockMarkDismissed(...a),
}));
vi.mock("../../../lib/enrich-lead.js", () => ({
  enrichLead: (...a: any[]) => mockEnrichLead(...a),
}));
vi.mock("../../../lib/agent-from-draft.js", () => ({
  loadDraft: (...a: any[]) => mockLoadDraft(...a),
  applyOverrides: (...a: any[]) => mockApplyOverrides(...a),
}));
vi.mock("../../../lib/agent-from-config.js", () => ({
  createAgentFromConfig: (...a: any[]) => mockCreateAgentFromConfig(...a),
}));
vi.mock("../../../middleware/require-role.js", () => ({
  requirePermission: () => (req: Request, _res: Response, next: NextFunction) => {
    mockRequirePermission(req);
    next();
  },
}));
// Token check is exercised in its own unit test; here we always allow so the
// route handler logic (toggle, sanitize, source default) is what's tested.
vi.mock("../../../middleware/require-service-token.js", () => ({
  requireServiceToken: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock("../../../lib/settings.js", () => ({
  getSettings: (...a: any[]) => mockGetSettings(...a),
}));

const { leadsRouter, leadsIntakeRouter } = await import("../index.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeReq(opts: { params?: any; body?: any; query?: any }): Request {
  return {
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: opts.query ?? {},
  } as any;
}

function findRoute(method: string, path: string, router: any = leadsRouter) {
  for (const layer of (router as any).stack as any[]) {
    if (!layer.route) continue;
    if (layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack;
    }
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

async function runRoute(method: string, path: string, req: Request, res: Response, router: any = leadsRouter) {
  const stack = findRoute(method, path, router);
  for (const layer of stack) {
    let advance = false;
    let nextErr: any = null;
    const next = (err?: any) => { if (err) nextErr = err; advance = true; };
    const result = layer.handle(req, res, next);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
    if (nextErr) throw nextErr;
    if (!advance) return;
  }
}

beforeEach(() => {
  for (const m of [
    mockCreatePendingLead, mockListPendingLeads, mockGetPendingLead,
    mockUpdatePendingLead, mockMarkPromoted, mockMarkDismissed,
    mockEnrichLead, mockLoadDraft, mockApplyOverrides, mockCreateAgentFromConfig,
    mockRequirePermission, mockGetSettings,
  ]) m.mockReset();
  mockUpdatePendingLead.mockResolvedValue({});
  mockMarkPromoted.mockResolvedValue(undefined);
  mockMarkDismissed.mockResolvedValue(undefined);
  // Default: intake enabled (fail-open) so most tests don't need to set it.
  mockGetSettings.mockResolvedValue({ lead_intake_enabled: undefined });
  // Default enrichment result so background tasks resolve cleanly even
  // when a test forgets to override.
  mockEnrichLead.mockResolvedValue({
    ok: true,
    business_name: "Acme",
    faqKnowledgeBase: "Q?\nA.",
    extra: {},
  });
  // Default: when runEnrichment re-checks the lead post-LLM, return a
  // non-terminal status so the dismissed/promoted guard doesn't trip.
  // Tests that exercise the race override this with status: 'dismissed'.
  mockGetPendingLead.mockResolvedValue({ _id: "default", status: "enriching" });
});

// ── POST / (intake) ────────────────────────────────────────────────────────

describe("POST /api/leads — intake", () => {
  it("returns 400 when name is missing", async () => {
    const res = makeRes();
    await runRoute("post", "/", makeReq({ body: { phone: "+1" } }), res);
    expect(res._status).toBe(400);
    expect(mockCreatePendingLead).not.toHaveBeenCalled();
  });

  it("returns 400 when name is whitespace-only", async () => {
    const res = makeRes();
    await runRoute("post", "/", makeReq({ body: { name: "   " } }), res);
    expect(res._status).toBe(400);
  });

  it("creates the lead and returns 201", async () => {
    const lead = { _id: "lead1", source: "manual", status: "queued" };
    mockCreatePendingLead.mockResolvedValue(lead);
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { name: "Acme Plumbing", phone: "+15551112222" },
    }), res);
    expect(res._status).toBe(201);
    expect(res._json).toBe(lead);
    expect(mockCreatePendingLead).toHaveBeenCalledWith({
      source: "manual",
      input: { name: "Acme Plumbing", phone: "+15551112222" },
    });
  });

  it("respects `source` from body when provided (e.g. 'sheet')", async () => {
    mockCreatePendingLead.mockResolvedValue({ _id: "x" });
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { name: "X", source: "sheet" },
    }), res);
    expect(mockCreatePendingLead).toHaveBeenCalledWith(
      expect.objectContaining({ source: "sheet" }),
    );
    expect(res._status).toBe(201);
  });

  it("does not overwrite a dismissed lead's status when fire-and-forget enrichment finishes (race fix)", async () => {
    // Operator (or test cleanup) dismisses the lead while enrichLead is
    // mid-flight. By the time enrichment returns, getPendingLead reports
    // status='dismissed', and runEnrichment must skip the final patch.
    mockCreatePendingLead.mockResolvedValue({ _id: "lead-race", status: "queued" });
    mockGetPendingLead.mockResolvedValue({ _id: "lead-race", status: "dismissed" });
    // Default mockEnrichLead in beforeEach already resolves with ok:true,
    // which is the case we care about — success path must still skip.
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { name: "Acme" },
    }), res);
    expect(res._status).toBe(201);

    // Drain microtasks so the fire-and-forget runEnrichment runs to
    // completion. updatePendingLead is invoked exactly once — for the
    // initial "enriching" flip — and the post-enrichment ready/failed
    // patch is skipped because the dismissed-status guard kicks in.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockUpdatePendingLead).toHaveBeenCalledTimes(1);
    expect(mockUpdatePendingLead.mock.calls[0][1]).toMatchObject({ status: "enriching" });
  });
});

// ── GET / (list) ───────────────────────────────────────────────────────────

describe("GET /api/leads — list", () => {
  it("returns the queue (excluding terminal statuses by default)", async () => {
    mockListPendingLeads.mockResolvedValue([{ _id: "1" }, { _id: "2" }]);
    const res = makeRes();
    await runRoute("get", "/", makeReq({}), res);
    expect(res._status).toBe(200);
    expect(res._json).toHaveLength(2);
    expect(mockListPendingLeads).toHaveBeenCalledWith({
      status: undefined, includeTerminal: false,
    });
  });

  it("forwards ?status=ready", async () => {
    mockListPendingLeads.mockResolvedValue([]);
    const res = makeRes();
    await runRoute("get", "/", makeReq({ query: { status: "ready" } }), res);
    expect(mockListPendingLeads).toHaveBeenCalledWith({
      status: "ready", includeTerminal: false,
    });
  });

  it("forwards ?include_terminal=1", async () => {
    mockListPendingLeads.mockResolvedValue([]);
    const res = makeRes();
    await runRoute("get", "/", makeReq({ query: { include_terminal: "1" } }), res);
    expect(mockListPendingLeads).toHaveBeenCalledWith({
      status: undefined, includeTerminal: true,
    });
  });
});

// ── GET /:id ───────────────────────────────────────────────────────────────

describe("GET /api/leads/:id", () => {
  it("returns 404 when missing", async () => {
    mockGetPendingLead.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("get", "/:id", makeReq({ params: { id: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns the doc on success", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1", input: { name: "Acme" } });
    const res = makeRes();
    await runRoute("get", "/:id", makeReq({ params: { id: "lead1" } }), res);
    expect(res._status).toBe(200);
    expect(res._json._id).toBe("lead1");
  });
});

// ── PATCH /:id ─────────────────────────────────────────────────────────────

describe("PATCH /api/leads/:id", () => {
  it("returns 404 when missing", async () => {
    mockGetPendingLead.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("patch", "/:id", makeReq({
      params: { id: "x" }, body: { enriched: { business_name: "Y" } },
    }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when the body has nothing editable", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1" });
    const res = makeRes();
    await runRoute("patch", "/:id", makeReq({
      params: { id: "lead1" }, body: { _id: "tampered" },
    }), res);
    expect(res._status).toBe(400);
  });

  it("merges enriched fields with existing values", async () => {
    mockGetPendingLead.mockResolvedValue({
      _id: "lead1",
      enriched: { business_name: "Old", faqKnowledgeBase: "Old FAQ" },
    });
    mockUpdatePendingLead.mockResolvedValue({ _id: "lead1", enriched: { business_name: "New", faqKnowledgeBase: "Old FAQ" } });
    const res = makeRes();
    await runRoute("patch", "/:id", makeReq({
      params: { id: "lead1" }, body: { enriched: { business_name: "New" } },
    }), res);
    expect(res._status).toBe(200);
    expect(mockUpdatePendingLead).toHaveBeenCalledWith("lead1", {
      enriched: { business_name: "New", faqKnowledgeBase: "Old FAQ" },
    });
  });

  // The dashboard's Editable Original Lead panel sends `input: {...}` so an
  // operator can correct a typo before re-enriching. The route sanitizes
  // and patches the input field on the lead doc.
  it("updates the editable original-lead input via PATCH", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1", input: { name: "Original" } });
    mockUpdatePendingLead.mockResolvedValue({});
    const res = makeRes();
    await runRoute("patch", "/:id", makeReq({
      params: { id: "lead1" },
      body: { input: { name: "Edited Name", phone: "+15558889999", website: "edited.com" } },
    }), res);
    expect(res._status).toBe(200);
    expect(mockUpdatePendingLead).toHaveBeenCalledWith("lead1", {
      input: { name: "Edited Name", phone: "+15558889999", website: "edited.com" },
    });
  });

  it("rejects PATCH input with empty / whitespace name (sanitizer-enforced)", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1", input: { name: "Original" } });
    const res = makeRes();
    await runRoute("patch", "/:id", makeReq({
      params: { id: "lead1" },
      body: { input: { name: "   ", phone: "+15558889999" } },
    }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/input\.name/);
    expect(mockUpdatePendingLead).not.toHaveBeenCalled();
  });

  it("trims whitespace and drops empty optional fields when PATCH-ing input", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1", input: { name: "Original" } });
    mockUpdatePendingLead.mockResolvedValue({});
    await runRoute("patch", "/:id", makeReq({
      params: { id: "lead1" },
      body: { input: { name: "  Edited  ", phone: "  +15558889999  ", website: "", notes: "   " } },
    }), makeRes());
    expect(mockUpdatePendingLead).toHaveBeenCalledWith("lead1", {
      input: { name: "Edited", phone: "+15558889999" },
    });
  });

  it("PATCH input + enriched + status in one call applies all three", async () => {
    mockGetPendingLead.mockResolvedValue({
      _id: "lead1",
      input: { name: "Old" },
      enriched: { faqKnowledgeBase: "old faq" },
    });
    mockUpdatePendingLead.mockResolvedValue({});
    await runRoute("patch", "/:id", makeReq({
      params: { id: "lead1" },
      body: {
        input: { name: "New" },
        enriched: { business_name: "Acme" },
        status: "ready",
      },
    }), makeRes());
    expect(mockUpdatePendingLead).toHaveBeenCalledWith("lead1", {
      input: { name: "New" },
      enriched: { faqKnowledgeBase: "old faq", business_name: "Acme" },
      status: "ready",
    });
  });
});

// ── /:id/re-enrich ─────────────────────────────────────────────────────────

describe("POST /api/leads/:id/re-enrich", () => {
  it("returns 404 when missing", async () => {
    mockGetPendingLead.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:id/re-enrich", makeReq({ params: { id: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("kicks off enrichment and returns 200 immediately", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1", input: { name: "Acme" } });
    const res = makeRes();
    await runRoute("post", "/:id/re-enrich", makeReq({ params: { id: "lead1" } }), res);
    expect(res._status).toBe(200);
    expect(res._json.status).toBe("enriching");
    // Background promise — give it a tick to fire.
    await new Promise((r) => setImmediate(r));
    expect(mockEnrichLead).toHaveBeenCalledWith({ name: "Acme" });
  });
});

// ── /:id/dismiss ───────────────────────────────────────────────────────────

describe("POST /api/leads/:id/dismiss", () => {
  it("404 when missing", async () => {
    mockGetPendingLead.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:id/dismiss", makeReq({ params: { id: "x" } }), res);
    expect(res._status).toBe(404);
  });

  it("marks the lead dismissed", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1" });
    const res = makeRes();
    await runRoute("post", "/:id/dismiss", makeReq({ params: { id: "lead1" } }), res);
    expect(res._status).toBe(200);
    expect(mockMarkDismissed).toHaveBeenCalledWith("lead1");
  });
});

// ── /:id/promote ───────────────────────────────────────────────────────────

describe("POST /api/leads/:id/promote", () => {
  const leadReady = {
    _id: "lead1",
    input: { name: "Acme Owner", phone: "+19739781542" },
    enriched: { business_name: "Acme", faqKnowledgeBase: "Q?\nA." },
  };
  const draft = { _id: "default", exportConfig: { /* presence is the assertion */ } };

  it("404 when lead missing", async () => {
    mockGetPendingLead.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "x" }, body: { draft: "default" },
    }), res);
    expect(res._status).toBe(404);
  });

  it("400 when body missing draft", async () => {
    mockGetPendingLead.mockResolvedValue(leadReady);
    const res = makeRes();
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "lead1" }, body: {},
    }), res);
    expect(res._status).toBe(400);
  });

  it("400 when enrichment hasn't filled both fields", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1", enriched: { business_name: "Only" } });
    const res = makeRes();
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "lead1" }, body: { draft: "default" },
    }), res);
    expect(res._status).toBe(400);
  });

  it("404 when draft missing", async () => {
    mockGetPendingLead.mockResolvedValue(leadReady);
    mockLoadDraft.mockResolvedValue(null);
    const res = makeRes();
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "lead1" }, body: { draft: "default" },
    }), res);
    expect(res._status).toBe(404);
  });

  it("happy path → marks lead promoted, returns slug", async () => {
    mockGetPendingLead.mockResolvedValue(leadReady);
    mockLoadDraft.mockResolvedValue(draft);
    mockApplyOverrides.mockReturnValue({ /* doesn't matter — passed through */ });
    mockCreateAgentFromConfig.mockResolvedValue({
      ok: true,
      slug: "acme",
      agentId: "agent_x",
      conversationFlowId: "cf_x",
      notificationConfig: {},
      provisionedNumber: "+15559998888",
      provisionError: null,
    });
    const res = makeRes();
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "lead1" }, body: { draft: "default" },
    }), res);
    expect(res._status).toBe(201);
    expect(res._json.slug).toBe("acme");
    expect(mockApplyOverrides).toHaveBeenCalledWith(
      draft.exportConfig,
      expect.objectContaining({
        business: { businessName: "Acme", faqKnowledgeBase: "Q?\nA." },
      }),
    );
    expect(mockMarkPromoted).toHaveBeenCalledWith("lead1", "acme");
  });

  it("carries the lead's name + phone + area-code timezone onto the new client doc", async () => {
    mockGetPendingLead.mockResolvedValue(leadReady);
    mockLoadDraft.mockResolvedValue(draft);
    mockApplyOverrides.mockReturnValue({});
    mockCreateAgentFromConfig.mockResolvedValue({ ok: true, slug: "acme", agentId: "a" });
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "lead1" }, body: { draft: "default" },
    }), makeRes());
    const overridesArg = mockApplyOverrides.mock.calls[0][1];
    expect(overridesArg.client.contact_name).toBe("Acme Owner");
    expect(overridesArg.client.contact_phone).toBe("+19739781542");
    // 973 is northern NJ → America/New_York per area-code-timezone lookup
    expect(overridesArg.client.contact_timezone).toBe("America/New_York");
  });

  it("operator-supplied client overrides win over the lead-derived contact defaults", async () => {
    mockGetPendingLead.mockResolvedValue(leadReady);
    mockLoadDraft.mockResolvedValue(draft);
    mockApplyOverrides.mockReturnValue({});
    mockCreateAgentFromConfig.mockResolvedValue({ ok: true, slug: "acme", agentId: "a" });
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "lead1" },
      body: { draft: "default", client: { contact_name: "Hand-edited" } },
    }), makeRes());
    const overridesArg = mockApplyOverrides.mock.calls[0][1];
    expect(overridesArg.client.contact_name).toBe("Hand-edited");
    // Phone wasn't overridden, so the lead-derived value remains.
    expect(overridesArg.client.contact_phone).toBe("+19739781542");
  });

  it("propagates createAgentFromConfig failure status without marking promoted", async () => {
    mockGetPendingLead.mockResolvedValue(leadReady);
    mockLoadDraft.mockResolvedValue(draft);
    mockApplyOverrides.mockReturnValue({});
    mockCreateAgentFromConfig.mockResolvedValue({
      ok: false, status: 502, error: "Retell down",
    });
    const res = makeRes();
    await runRoute("post", "/:id/promote", makeReq({
      params: { id: "lead1" }, body: { draft: "default" },
    }), res);
    expect(res._status).toBe(502);
    expect(mockMarkPromoted).not.toHaveBeenCalled();
  });
});

// ── POST /api/leads/intake (Apps Script) ───────────────────────────────────

describe("POST /api/leads/intake", () => {
  it("returns 423 when lead_intake_enabled is false", async () => {
    mockGetSettings.mockResolvedValue({ lead_intake_enabled: false });
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { name: "Acme" },
    }), res, leadsIntakeRouter);
    expect(res._status).toBe(423);
    expect(mockCreatePendingLead).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing even though intake is enabled", async () => {
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { phone: "+15551112222" },
    }), res, leadsIntakeRouter);
    expect(res._status).toBe(400);
    expect(mockCreatePendingLead).not.toHaveBeenCalled();
  });

  it("creates the lead with source defaulting to google_sheet and returns 201 with id+status", async () => {
    mockCreatePendingLead.mockResolvedValue({ _id: "abc", source: "google_sheet", status: "queued" });
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { name: "Acme Plumbing", phone: "+15551112222" },
    }), res, leadsIntakeRouter);
    expect(res._status).toBe(201);
    expect(res._json).toEqual({ _id: "abc", status: "queued" });
    expect(mockCreatePendingLead).toHaveBeenCalledWith({
      source: "google_sheet",
      input: { name: "Acme Plumbing", phone: "+15551112222" },
    });
  });

  it("respects an explicit source from the body (e.g. a different sheet name)", async () => {
    mockCreatePendingLead.mockResolvedValue({ _id: "x", status: "queued" });
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { name: "Acme", source: "facebook_csv" },
    }), res, leadsIntakeRouter);
    expect(mockCreatePendingLead).toHaveBeenCalledWith(
      expect.objectContaining({ source: "facebook_csv" }),
    );
  });

  it("treats undefined lead_intake_enabled as enabled (fail-open default)", async () => {
    mockGetSettings.mockResolvedValue({}); // no lead_intake_enabled key at all
    mockCreatePendingLead.mockResolvedValue({ _id: "y", status: "queued" });
    const res = makeRes();
    await runRoute("post", "/", makeReq({
      body: { name: "Acme" },
    }), res, leadsIntakeRouter);
    expect(res._status).toBe(201);
  });
});

// ── AI Feed transcript stash (`runEnrichment`) ──────────────────────────────
//
// The dashboard's AI Feed panel renders the system prompt, user message,
// raw response, and content blocks the model returned, so an operator can
// see exactly what got sent and what came back — even on parse failure.
// `runEnrichment` (in routes/leads/index.ts) stashes those four values into
// `enriched.extra` under `_systemPrompt` / `_userMessage` / `_rawResponse` /
// `_rawContentBlocks` keys. These tests drive intake POST and re-enrich,
// flush the background promise, then inspect the persisted shape.

describe("runEnrichment — AI Feed transcript stash", () => {
  // Flush all pending microtasks (the promise that runs in the background
  // after the route returns 201). We need a few ticks to clear because the
  // helper does several awaits in sequence.
  async function flushBackgroundEnrichment() {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
    }
  }

  const transcriptShape = {
    systemPrompt: "SYSTEM_PROMPT_FROM_SKILL",
    userMessage: "USER_MESSAGE_AS_FORMATTED",
    rawResponse: '{"businessName":"Acme","faqKnowledgeBase":"Q?"}',
    rawContentBlocks: '[{"type":"text","text":"..."}]',
  };

  it("stashes the AI Feed transcript under enriched.extra on success", async () => {
    mockCreatePendingLead.mockResolvedValue({ _id: "lead1", source: "manual", status: "queued" });
    mockEnrichLead.mockResolvedValue({
      ok: true,
      business_name: "Acme",
      faqKnowledgeBase: "Q?",
      extra: { business_type: "plumbing" },
      ...transcriptShape,
    });
    await runRoute("post", "/", makeReq({ body: { name: "Acme" } }), makeRes());
    await flushBackgroundEnrichment();

    // First call sets status=enriching; the second is the result write.
    const calls = mockUpdatePendingLead.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const finalCall = calls[calls.length - 1];
    expect(finalCall[0]).toBe("lead1");
    const final = finalCall[1];
    expect(final.status).toBe("ready");
    // The skill's `extra` AND the AI Feed transcript both land in extra.
    expect(final.enriched.extra.business_type).toBe("plumbing");
    expect(final.enriched.extra._systemPrompt).toBe("SYSTEM_PROMPT_FROM_SKILL");
    expect(final.enriched.extra._userMessage).toBe("USER_MESSAGE_AS_FORMATTED");
    expect(final.enriched.extra._rawResponse).toContain("businessName");
    expect(final.enriched.extra._rawContentBlocks).toContain("text");
  });

  it("stashes the AI Feed transcript on parse-failure and merges with prior enriched fields", async () => {
    mockCreatePendingLead.mockResolvedValue({ _id: "lead1", source: "manual", status: "queued" });
    // Prior state: a previous enrichment succeeded, so enriched.business_name
    // exists. The new attempt fails — we want the OLD business_name preserved
    // and the new transcript stashed alongside.
    mockGetPendingLead.mockResolvedValue({
      _id: "lead1",
      enriched: { business_name: "Prior Name", extra: { _userMessage: "OLD" } },
    });
    mockEnrichLead.mockResolvedValue({
      ok: false,
      error: "could not parse JSON from skill response",
      ...transcriptShape,
    });
    await runRoute("post", "/", makeReq({ body: { name: "Acme" } }), makeRes());
    await flushBackgroundEnrichment();

    const finalCall = mockUpdatePendingLead.mock.calls.at(-1)!;
    const final = finalCall[1];
    expect(final.status).toBe("failed");
    expect(final.enrichmentError).toMatch(/parse/i);
    // Prior enriched fields survive — operator-edited business_name isn't lost.
    expect(final.enriched.business_name).toBe("Prior Name");
    // New transcript is in extra; old extra entries also survive.
    expect(final.enriched.extra._systemPrompt).toBe("SYSTEM_PROMPT_FROM_SKILL");
    expect(final.enriched.extra._userMessage).toBe("USER_MESSAGE_AS_FORMATTED");
  });

  it("re-enrich (POST /:id/re-enrich) also stashes the transcript", async () => {
    mockGetPendingLead.mockResolvedValue({ _id: "lead1", input: { name: "Acme" } });
    mockEnrichLead.mockResolvedValue({
      ok: true,
      business_name: "Acme",
      faqKnowledgeBase: "Q?",
      extra: {},
      ...transcriptShape,
    });
    await runRoute("post", "/:id/re-enrich", makeReq({ params: { id: "lead1" } }), makeRes());
    await flushBackgroundEnrichment();

    const finalCall = mockUpdatePendingLead.mock.calls.at(-1)!;
    const final = finalCall[1];
    expect(final.status).toBe("ready");
    expect(final.enriched.extra._userMessage).toBe("USER_MESSAGE_AS_FORMATTED");
    expect(final.enriched.extra._rawContentBlocks).toContain("text");
  });

  it("flips status to `enriching` and clears prior error before the model call", async () => {
    mockCreatePendingLead.mockResolvedValue({ _id: "lead1", source: "manual", status: "queued" });
    mockEnrichLead.mockResolvedValue({
      ok: true,
      business_name: "X",
      faqKnowledgeBase: "Y",
      extra: {},
      ...transcriptShape,
    });
    await runRoute("post", "/", makeReq({ body: { name: "X" } }), makeRes());
    await flushBackgroundEnrichment();

    const firstCall = mockUpdatePendingLead.mock.calls[0];
    expect(firstCall[1]).toEqual({ status: "enriching", enrichmentError: undefined });
  });
});
