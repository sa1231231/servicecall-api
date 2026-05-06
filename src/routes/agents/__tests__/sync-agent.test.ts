import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const {
  mockFlowCreate, mockFlowDelete, mockAgentCreate,
  mockNotificationClients,
  mockPersistClient, mockGetClientDocument,
  mockDeriveNotificationConfig,
  mockFetchRetellAgent, mockExtractFlowParams, mockExtractAgentParams,
  mockGenerateSlug,
} = vi.hoisted(() => ({
  mockFlowCreate: vi.fn(),
  mockFlowDelete: vi.fn(),
  mockAgentCreate: vi.fn(),
  mockNotificationClients: {} as Record<string, any>,
  mockPersistClient: vi.fn(),
  mockGetClientDocument: vi.fn(),
  mockDeriveNotificationConfig: vi.fn(),
  mockFetchRetellAgent: vi.fn(),
  mockExtractFlowParams: vi.fn(),
  mockExtractAgentParams: vi.fn(),
  mockGenerateSlug: vi.fn(),
}));

vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "test_key" } }));
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
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
}));
vi.mock("../../../lib/notification-config.js", () => ({
  deriveNotificationConfig: (...a: any[]) => mockDeriveNotificationConfig(...a),
}));
vi.mock("../../../lib/retell-sync.js", () => ({
  fetchRetellAgent: (...a: any[]) => mockFetchRetellAgent(...a),
  extractFlowParams: (...a: any[]) => mockExtractFlowParams(...a),
  extractAgentParams: (...a: any[]) => mockExtractAgentParams(...a),
}));
vi.mock("../../../lib/slug.js", () => ({
  generateSlug: (...a: any[]) => mockGenerateSlug(...a),
}));

const { importAgentHandler, syncAgentHandler, duplicateAgentHandler } =
  await import("../sync-agent.js");

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeReq(opts: { body?: any; params?: any; query?: any }): Request {
  return {
    body: opts.body ?? {},
    params: opts.params ?? {},
    query: opts.query ?? {},
  } as any;
}

beforeEach(() => {
  for (const m of [
    mockFlowCreate, mockFlowDelete, mockAgentCreate,
    mockPersistClient, mockGetClientDocument, mockDeriveNotificationConfig,
    mockFetchRetellAgent, mockExtractFlowParams, mockExtractAgentParams,
    mockGenerateSlug,
  ]) m.mockReset();

  for (const k of Object.keys(mockNotificationClients)) delete mockNotificationClients[k];

  mockPersistClient.mockResolvedValue(undefined);
  mockDeriveNotificationConfig.mockReturnValue({
    message_types: { default: { fields: [] } },
    default_message_type: "default",
  });
  mockGenerateSlug.mockImplementation((name: string) =>
    name.toLowerCase().replace(/\s+/g, "-"),
  );
});

// ── importAgentHandler ─────────────────────────────────────────────────────

describe("importAgentHandler", () => {
  it("returns 400 when agent_id missing", async () => {
    const res = makeRes();
    await importAgentHandler(makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when client.name missing — does not fall back to Retell agent_name", async () => {
    const res = makeRes();
    await importAgentHandler(makeReq({ body: { agent_id: "agent_1" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/client\.name/);
  });

  it("returns 400 when client.name is whitespace-only", async () => {
    const res = makeRes();
    await importAgentHandler(makeReq({ body: { agent_id: "agent_1", client: { name: "   " } } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 409 when slug already exists", async () => {
    mockNotificationClients["acme"] = {};
    mockFetchRetellAgent.mockResolvedValue({
      agentId: "agent_1", agentName: "Acme", canonicalJson: {}, conversationFlowId: "f", variables: [],
    });
    const res = makeRes();
    await importAgentHandler(makeReq({ body: { agent_id: "agent_1", client: { slug: "acme", name: "Acme" } } }), res);
    expect(res._status).toBe(409);
    expect(res._json.error).toMatch(/already exists/);
  });

  it("auto-generates slug from explicit client.name (not Retell's agent_name)", async () => {
    mockFetchRetellAgent.mockResolvedValue({
      agentId: "agent_1", agentName: "[DELETED] Stale Name",
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "f", variables: [],
    });
    const res = makeRes();
    await importAgentHandler(makeReq({ body: { agent_id: "agent_1", client: { name: "Acme Inc" } } }), res);
    expect(res._status).toBe(201);
    expect(res._json.slug).toBe("acme-inc");
    expect(mockGenerateSlug).toHaveBeenCalledWith("Acme Inc");
  });

  it("imports successfully and persists with shadow_mode default true", async () => {
    mockFetchRetellAgent.mockResolvedValue({
      agentId: "agent_1", agentName: "Acme",
      canonicalJson: { conversationFlow: {} }, conversationFlowId: "flow_1", variables: ["v1"],
    });
    const res = makeRes();
    await importAgentHandler(makeReq({ body: { agent_id: "agent_1", client: { name: "Acme" } } }), res);
    expect(res._status).toBe(201);
    expect(res._json).toMatchObject({
      success: true, agent_id: "agent_1", agent_name: "Acme", conversation_flow_id: "flow_1",
    });
    const persistedEntry = mockPersistClient.mock.calls[0][1];
    expect(persistedEntry.retell_agents).toHaveProperty("agent_1");
    // The clientInfo passed to deriveNotificationConfig should have shadow_mode: true
    const derivedCall = mockDeriveNotificationConfig.mock.calls[0];
    expect(derivedCall[1].shadow_mode).toBe(true);
  });

  it("respects shadow_mode override from client body", async () => {
    mockFetchRetellAgent.mockResolvedValue({
      agentId: "agent_1", agentName: "Acme",
      canonicalJson: {}, conversationFlowId: "f", variables: [],
    });
    const res = makeRes();
    await importAgentHandler(makeReq({ body: { agent_id: "agent_1", client: { name: "Acme", shadow_mode: false } } }), res);
    expect(res._status).toBe(201);
    const derivedCall = mockDeriveNotificationConfig.mock.calls[0];
    expect(derivedCall[1].shadow_mode).toBe(false);
  });

  it("returns 502 when Retell fetch fails", async () => {
    mockFetchRetellAgent.mockRejectedValue(new Error("retell down"));
    const res = makeRes();
    await importAgentHandler(makeReq({ body: { agent_id: "agent_1", client: { name: "Acme" } } }), res);
    expect(res._status).toBe(502);
    expect(res._json.error).toBe("Failed to import agent from Retell");
    expect(res._json.details).toBe("retell down");
  });
});

// ── syncAgentHandler ───────────────────────────────────────────────────────

describe("syncAgentHandler", () => {
  it("returns 404 when client not found", async () => {
    mockGetClientDocument.mockResolvedValue(null);
    const res = makeRes();
    await syncAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(404);
  });

  it("returns 400 when no agent_id resolvable", async () => {
    mockGetClientDocument.mockResolvedValue({ name: "Acme" });
    const res = makeRes();
    await syncAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(400);
  });

  it("uses agent_id from query param when provided", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Acme", agent_id: "agent_default",
      retell_agents: { agent_default: {}, agent_other: {} },
    });
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: {}, variables: [],
    });
    const res = makeRes();
    await syncAgentHandler(makeReq({
      params: { slug: "acme" },
      query: { agent_id: "agent_other" },
    }), res);
    expect(res._status).toBe(200);
    expect(res._json.agent_id).toBe("agent_other");
    // fetchRetellAgent should be called with agent_other
    expect(mockFetchRetellAgent.mock.calls[0][1]).toBe("agent_other");
  });

  it("preserves existing dispatch info when re-syncing", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Acme", agent_id: "agent_1",
      dispatch_text_numbers: ["+1"],
      dispatch_email: ["a@b.com"],
      shadow_mode: false,
    });
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: {}, variables: [],
    });
    const res = makeRes();
    await syncAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    // The clientInfo passed to deriveNotificationConfig keeps existing dispatch_text_numbers
    const derivedCall = mockDeriveNotificationConfig.mock.calls[0];
    expect(derivedCall[1].dispatch_text_numbers).toEqual(["+1"]);
    expect(derivedCall[1].shadow_mode).toBe(false);
  });

  it("preserves existing field-level customizations on re-sync", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Acme", agent_id: "agent_1",
      message_types: {
        default: {
          label: "Lead",
          fields: [
            { key: "phone", label: "Custom Phone Label", show: false },
          ],
        },
      },
    });
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: {}, variables: [],
    });
    mockDeriveNotificationConfig.mockReturnValue({
      message_types: {
        default: {
          label: "Lead",
          fields: [{ key: "phone", label: "Phone", show: true }],
        },
      },
      default_message_type: "default",
    });
    const res = makeRes();
    await syncAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    const persisted = mockPersistClient.mock.calls[0][1];
    const phoneField = persisted.message_types.default.fields[0];
    expect(phoneField.label).toBe("Custom Phone Label");
    expect(phoneField.show).toBe(false);
  });

  it("explicit-allowlist merge preserves display_name, contact_*, and folder_id from existingDoc", async () => {
    // Regression: the syncAgent merge used to be a blocklist-by-omission spread
    // (`{...existingDoc, ...jsonEntry, agent_id, ...}`). Any new field added
    // to JsonClientEntry that wasn't explicitly listed would silently inherit
    // from existingDoc — a stale-fallback bug shape. The merge is now an
    // explicit allowlist, and these fields must be in it.
    mockGetClientDocument.mockResolvedValue({
      name: "Acme",
      agent_id: "agent_1",
      display_name: "Acme — Pretty Label",
      contact_name: "Jane Doe",
      contact_phone: "+15551234567",
      contact_email: "jane@acme.com",
      contact_timezone: "America/New_York",
      contact_notes: "VIP",
      folder_id: "folder_abc",
      portal_token: "ptk_xyz",
      shadow_mode: false,
      active: true,
    });
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: {}, variables: [],
    });
    mockDeriveNotificationConfig.mockReturnValue({
      message_types: { default: { label: "Lead", fields: [] } },
      default_message_type: "default",
    });

    const res = makeRes();
    await syncAgentHandler(makeReq({ params: { slug: "acme" } }), res);

    expect(res._status).toBe(200);
    const persisted = mockPersistClient.mock.calls[0][1];
    expect(persisted.display_name).toBe("Acme — Pretty Label");
    expect(persisted.contact_name).toBe("Jane Doe");
    expect(persisted.contact_phone).toBe("+15551234567");
    expect(persisted.contact_email).toBe("jane@acme.com");
    expect(persisted.contact_timezone).toBe("America/New_York");
    expect(persisted.contact_notes).toBe("VIP");
    expect(persisted.folder_id).toBe("folder_abc");
    expect(persisted.portal_token).toBe("ptk_xyz");
    expect(persisted.active).toBe(true);
    expect(persisted.shadow_mode).toBe(false);
  });

  it("preserves resolve_rules when manually configured", async () => {
    mockGetClientDocument.mockResolvedValue({
      name: "Acme", agent_id: "agent_1",
      resolve_rules: [{ if: "x", equals: "y", then: "z" }],
      resolve_rule: "old",
    });
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: {}, variables: [],
    });
    const res = makeRes();
    await syncAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(200);
    const persisted = mockPersistClient.mock.calls[0][1];
    expect(persisted.resolve_rules).toEqual([{ if: "x", equals: "y", then: "z" }]);
    expect(persisted.resolve_rule).toBeUndefined();
  });

  it("returns 502 when Retell fetch fails", async () => {
    mockGetClientDocument.mockResolvedValue({ name: "Acme", agent_id: "agent_1" });
    mockFetchRetellAgent.mockRejectedValue(new Error("retell down"));
    const res = makeRes();
    await syncAgentHandler(makeReq({ params: { slug: "acme" } }), res);
    expect(res._status).toBe(502);
  });
});

// ── duplicateAgentHandler ──────────────────────────────────────────────────

describe("duplicateAgentHandler", () => {
  it("returns 400 when source_agent_id missing", async () => {
    const res = makeRes();
    await duplicateAgentHandler(makeReq({ body: {} }), res);
    expect(res._status).toBe(400);
  });

  it("returns 400 when client.name missing — does not fall back to source agent's name", async () => {
    const res = makeRes();
    await duplicateAgentHandler(makeReq({ body: { source_agent_id: "src1" } }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/client\.name/);
  });

  it("returns 400 when client.name is whitespace-only", async () => {
    const res = makeRes();
    await duplicateAgentHandler(makeReq({ body: { source_agent_id: "src1", client: { name: "   " } } }), res);
    expect(res._status).toBe(400);
  });

  it("returns 409 when slug already exists", async () => {
    mockNotificationClients["acme"] = {};
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: { conversationFlow: {} }, variables: [],
    });
    const res = makeRes();
    await duplicateAgentHandler(makeReq({
      body: { source_agent_id: "src1", client: { slug: "acme", name: "Acme Copy" } },
    }), res);
    expect(res._status).toBe(409);
  });

  it("creates new flow + new agent + persists, returns 201", async () => {
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme",
      canonicalJson: { conversationFlow: { x: 1 } },
      variables: ["v1"],
    });
    mockExtractFlowParams.mockReturnValue({ name: "flow" });
    mockExtractAgentParams.mockReturnValue({ name: "Acme Copy", agent_name: "Acme Copy" });
    mockFlowCreate.mockResolvedValue({ conversation_flow_id: "flow_NEW" });
    mockAgentCreate.mockResolvedValue({ agent_id: "agent_NEW" });
    const res = makeRes();
    await duplicateAgentHandler(makeReq({
      body: { source_agent_id: "src1", client: { name: "Acme Copy" } },
    }), res);
    expect(res._status).toBe(201);
    expect(res._json).toMatchObject({
      success: true, agent_id: "agent_NEW", conversation_flow_id: "flow_NEW",
      source_agent_id: "src1",
    });
    expect(mockFlowCreate).toHaveBeenCalledWith({ name: "flow" });
    expect(mockAgentCreate).toHaveBeenCalled();
    expect(mockPersistClient).toHaveBeenCalled();
    // Should NOT call cleanup
    expect(mockFlowDelete).not.toHaveBeenCalled();
  });

  it("cleans up flow when agent.create fails", async () => {
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: { conversationFlow: {} }, variables: [],
    });
    mockExtractFlowParams.mockReturnValue({});
    mockExtractAgentParams.mockReturnValue({});
    mockFlowCreate.mockResolvedValue({ conversation_flow_id: "flow_NEW" });
    mockAgentCreate.mockRejectedValue(new Error("agent create failed"));
    mockFlowDelete.mockResolvedValue(undefined);
    const res = makeRes();
    await duplicateAgentHandler(makeReq({
      body: { source_agent_id: "src1", client: { name: "Acme Copy" } },
    }), res);
    expect(res._status).toBe(502);
    expect(res._json.details).toBe("agent create failed");
    // Cleanup must have been attempted
    expect(mockFlowDelete).toHaveBeenCalledWith("flow_NEW");
  });

  it("does not crash if cleanup itself fails after agent create error", async () => {
    mockFetchRetellAgent.mockResolvedValue({
      agentName: "Acme", canonicalJson: { conversationFlow: {} }, variables: [],
    });
    mockExtractFlowParams.mockReturnValue({});
    mockExtractAgentParams.mockReturnValue({});
    mockFlowCreate.mockResolvedValue({ conversation_flow_id: "flow_NEW" });
    mockAgentCreate.mockRejectedValue(new Error("agent failed"));
    mockFlowDelete.mockRejectedValue(new Error("cleanup also failed"));
    const res = makeRes();
    await duplicateAgentHandler(makeReq({ body: { source_agent_id: "src1", client: { name: "Acme Copy" } } }), res);
    expect(res._status).toBe(502);
    expect(res._json.details).toBe("agent failed");
  });

  it("returns 502 when source fetch fails (no flow created, no cleanup)", async () => {
    mockFetchRetellAgent.mockRejectedValue(new Error("not found"));
    const res = makeRes();
    await duplicateAgentHandler(makeReq({ body: { source_agent_id: "src1", client: { name: "Acme Copy" } } }), res);
    expect(res._status).toBe(502);
    expect(mockFlowDelete).not.toHaveBeenCalled();
  });
});
