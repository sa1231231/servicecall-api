import { describe, it, expect, vi, beforeEach } from "vitest";
import { ruleToFunction, toClientConfig } from "../client-store.js";
import type { JsonClientEntry, ResolveRule, ResolveRuleEntry } from "../client-store.js";

// ── ruleToFunction ──────────────────────────────────────────────────────────

describe("ruleToFunction", () => {
  it("returns defaultType when no rules provided", () => {
    const fn = ruleToFunction(undefined, undefined, "fallback");
    expect(fn({})).toBe("fallback");
    expect(fn({ anything: "value" })).toBe("fallback");
  });

  it("resolves binary rule — then branch", () => {
    const rule: ResolveRule = {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    };
    const fn = ruleToFunction(rule, undefined, "service_request");
    expect(fn({ is_emergency: "true" })).toBe("emergency");
  });

  it("resolves binary rule — else branch", () => {
    const rule: ResolveRule = {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    };
    const fn = ruleToFunction(rule, undefined, "service_request");
    expect(fn({ is_emergency: "false" })).toBe("service_request");
    expect(fn({})).toBe("service_request");
  });

  it("resolves multi-path rules — first match wins", () => {
    const rules: ResolveRuleEntry[] = [
      { field: "path", equals: "Residential", then: "residential" },
      { field: "path", equals: "Commercial", then: "commercial" },
    ];
    const fn = ruleToFunction(undefined, rules, "default");
    expect(fn({ path: "Residential" })).toBe("residential");
    expect(fn({ path: "Commercial" })).toBe("commercial");
  });

  it("returns defaultType when no multi-path rule matches", () => {
    const rules: ResolveRuleEntry[] = [
      { field: "path", equals: "Residential", then: "residential" },
    ];
    const fn = ruleToFunction(undefined, rules, "default");
    expect(fn({ path: "Other" })).toBe("default");
    expect(fn({})).toBe("default");
  });

  it("multi-path rules take precedence over binary rule", () => {
    const rule: ResolveRule = {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    };
    const rules: ResolveRuleEntry[] = [
      { field: "path", equals: "VIP", then: "vip" },
    ];
    const fn = ruleToFunction(rule, rules, "default");
    // Multi-path should win
    expect(fn({ path: "VIP" })).toBe("vip");
    // Binary rule ignored when multi-path rules exist
    expect(fn({ is_emergency: "true" })).toBe("default");
  });
});

// ── toClientConfig ──────────────────────────────────────────────────────────

describe("toClientConfig", () => {
  function makeEntry(overrides: Partial<JsonClientEntry> = {}): JsonClientEntry {
    return {
      name: "Test Co",
      agent_ids: ["agent_1"],
      dispatch_text_numbers: ["+15551234567"],
      dispatch_call_number: null,
      summary_agent_id: null,
      outbound_from_number: null,
      dispatch_email: ["test@test.com"],
      dispatch_cc: null,
      message_types: {
        service_request: {
          label: "SR",
          subject_template: "SR",
          fields: [{ key: "name", label: "Name" }],
        },
      },
      default_message_type: "service_request",
      ...overrides,
    };
  }

  it("converts entry to config with resolve_type function", () => {
    const config = toClientConfig(makeEntry());
    expect(typeof config.resolve_type).toBe("function");
    expect(config.resolve_type({})).toBe("service_request");
  });

  it("passes through all dispatch fields", () => {
    const entry = makeEntry({
      dispatch_email: ["a@b.com", "c@d.com"],
      dispatch_cc: "cc@test.com",
      dispatch_call_number: "+15559999999",
    });
    const config = toClientConfig(entry);
    expect(config.dispatch_email).toEqual(["a@b.com", "c@d.com"]);
    expect(config.dispatch_cc).toBe("cc@test.com");
    expect(config.dispatch_call_number).toBe("+15559999999");
  });

  it("preserves shadow_mode", () => {
    expect(toClientConfig(makeEntry({ shadow_mode: true })).shadow_mode).toBe(true);
    expect(toClientConfig(makeEntry({ shadow_mode: false })).shadow_mode).toBe(false);
    expect(toClientConfig(makeEntry()).shadow_mode).toBeUndefined();
  });

  it("preserves active field", () => {
    expect(toClientConfig(makeEntry({ active: true })).active).toBe(true);
    expect(toClientConfig(makeEntry({ active: false })).active).toBe(false);
    expect(toClientConfig(makeEntry()).active).toBeUndefined();
  });

  it("preserves outbound_from_number", () => {
    const config = toClientConfig(makeEntry({ outbound_from_number: "+15551234567" }));
    expect(config.outbound_from_number).toBe("+15551234567");
    expect(toClientConfig(makeEntry()).outbound_from_number).toBeNull();
  });

  it("wires up binary resolve_rule", () => {
    const config = toClientConfig(
      makeEntry({
        resolve_rule: {
          field: "is_emergency",
          equals: "true",
          then: "emergency",
          else: "service_request",
        },
      }),
    );
    expect(config.resolve_type({ is_emergency: "true" })).toBe("emergency");
    expect(config.resolve_type({ is_emergency: "false" })).toBe("service_request");
  });

  it("wires up multi-path resolve_rules", () => {
    const config = toClientConfig(
      makeEntry({
        resolve_rules: [
          { field: "type", equals: "A", then: "type_a" },
          { field: "type", equals: "B", then: "type_b" },
        ],
      }),
    );
    expect(config.resolve_type({ type: "A" })).toBe("type_a");
    expect(config.resolve_type({ type: "B" })).toBe("type_b");
    expect(config.resolve_type({})).toBe("service_request");
  });

  it("passes through dispatch_by_type when present", () => {
    const byType = {
      automotive: {
        dispatch_text_numbers: ["+15559999999"],
        dispatch_email: ["auto@test.com"],
      },
    };
    const config = toClientConfig(makeEntry({ dispatch_by_type: byType }));
    expect(config.dispatch_by_type).toEqual(byType);
  });

  it("dispatch_by_type is undefined when not set", () => {
    const config = toClientConfig(makeEntry());
    expect(config.dispatch_by_type).toBeUndefined();
  });
});

// ── DB-backed functions (mocked) ────────────────────────────────────────────

const {
  mockFindOne, mockFind, mockReplaceOne, mockUpdateOne, mockDeleteOne, mockDeleteMany,
  mockNotificationClients, mockAgentIdToClient, mockAgentIdToSlug, mockPhoneNumberToClient,
} = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockFind: vi.fn(),
  mockReplaceOne: vi.fn(),
  mockUpdateOne: vi.fn(),
  mockDeleteOne: vi.fn(),
  mockDeleteMany: vi.fn(),
  mockNotificationClients: {} as Record<string, any>,
  mockAgentIdToClient: {} as Record<string, any>,
  mockAgentIdToSlug: {} as Record<string, string>,
  mockPhoneNumberToClient: {} as Record<string, any>,
}));

vi.mock("../../lib/db.js", () => ({
  getDb: () => ({
    collection: () => ({
      findOne: mockFindOne,
      find: mockFind,
      replaceOne: mockReplaceOne,
      updateOne: mockUpdateOne,
      deleteOne: mockDeleteOne,
      deleteMany: mockDeleteMany,
    }),
  }),
}));

vi.mock("../../_cache/clients.js", () => ({
  notificationClients: mockNotificationClients,
  agentIdToClient: mockAgentIdToClient,
  agentIdToSlug: mockAgentIdToSlug,
  phoneNumberToClient: mockPhoneNumberToClient,
}));

const {
  loadClientsFromDb, persistClient, updateClientField, updateClientFields,
  softDeleteClient, restoreClient, listDeletedClients, deleteClient,
  getClientDocument, getAllClientDocuments, getAllClientSummaries,
  generatePortalToken, findClientsByEmail, validatePortalToken,
} = await import("../client-store.js");

function chainable(items: any[]) {
  return {
    sort: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(items),
  };
}

function clearCaches() {
  for (const k of Object.keys(mockNotificationClients)) delete mockNotificationClients[k];
  for (const k of Object.keys(mockAgentIdToClient)) delete mockAgentIdToClient[k];
  for (const k of Object.keys(mockAgentIdToSlug)) delete mockAgentIdToSlug[k];
  for (const k of Object.keys(mockPhoneNumberToClient)) delete mockPhoneNumberToClient[k];
}

function makeDoc(overrides: Partial<JsonClientEntry & { _id: string }> = {}) {
  return {
    _id: "acme",
    name: "Acme",
    agent_ids: ["agent_a"],
    dispatch_text_numbers: ["+15550001111"],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: null,
    dispatch_cc: null,
    message_types: {
      default: { label: "Default", subject_template: "", fields: [] },
    },
    default_message_type: "default",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCaches();
});

describe("loadClientsFromDb", () => {
  it("loads docs and registers in-memory maps", async () => {
    mockFind.mockReturnValue(chainable([
      makeDoc({ _id: "a", agent_ids: ["agent_a"], outbound_from_number: "+15551111111" }),
      makeDoc({ _id: "b", agent_ids: ["agent_b1", "agent_b2"] }),
    ]));

    await loadClientsFromDb();

    expect(mockNotificationClients.a).toBeDefined();
    expect(mockNotificationClients.b).toBeDefined();
    expect(mockAgentIdToClient.agent_a).toBeDefined();
    expect(mockAgentIdToClient.agent_b1).toBeDefined();
    expect(mockAgentIdToClient.agent_b2).toBeDefined();
    expect(mockAgentIdToSlug.agent_a).toBe("a");
    expect(mockAgentIdToSlug.agent_b1).toBe("b");
    expect(mockPhoneNumberToClient["+15551111111"]?.slug).toBe("a");
  });

  it("excludes soft-deleted docs (filter by deletedAt: $exists: false)", async () => {
    mockFind.mockReturnValue(chainable([]));
    await loadClientsFromDb();
    expect(mockFind).toHaveBeenCalledWith({ deletedAt: { $exists: false } });
  });

  it("skips docs with missing agent_ids", async () => {
    mockFind.mockReturnValue(chainable([
      { _id: "broken", name: "Broken" }, // no agent_ids
    ]));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await loadClientsFromDb();

    expect(mockNotificationClients.broken).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("missing agent_ids"));
    log.mockRestore();
  });
});

describe("persistClient", () => {
  it("upserts via replaceOne and stamps last_deployed_at", async () => {
    mockReplaceOne.mockResolvedValue({});
    const before = Date.now();

    const entry = makeDoc({ _id: undefined as any });
    delete (entry as any)._id;

    const config = await persistClient("acme", entry as any);

    expect(mockReplaceOne).toHaveBeenCalledWith(
      { _id: "acme" },
      expect.objectContaining({ _id: "acme" }),
      { upsert: true },
    );
    expect(typeof (entry as any).last_deployed_at).toBe("string");
    expect(new Date((entry as any).last_deployed_at).getTime()).toBeGreaterThanOrEqual(before);
    // In-memory registered
    expect(mockNotificationClients.acme).toBeDefined();
    expect(config.name).toBe("Acme");
  });
});

describe("updateClientField", () => {
  it("updates a single field and reflects change in memory", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockNotificationClients.acme = { name: "Old" } as any;

    await updateClientField("acme", "name", "New");

    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: "acme" }, { $set: { name: "New" } });
    expect(mockNotificationClients.acme.name).toBe("New");
  });

  it("throws when client not found", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(updateClientField("missing", "name", "X")).rejects.toThrow("not found");
  });
});

describe("updateClientFields", () => {
  it("rejects fields not in whitelist", async () => {
    await expect(
      updateClientFields("acme", { secret_field: "haxx" }),
    ).rejects.toThrow(/not editable/);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("rejects empty updates", async () => {
    await expect(updateClientFields("acme", {})).rejects.toThrow(/No valid fields/);
  });

  it("throws when matchedCount is 0", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(
      updateClientFields("acme", { name: "X" }),
    ).rejects.toThrow(/not found/);
  });

  it("re-registers agent_ids when they change", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const existing = { name: "Acme", agent_ids: ["old_id"], outbound_from_number: null } as any;
    mockNotificationClients.acme = existing;
    mockAgentIdToClient.old_id = existing;
    mockAgentIdToSlug.old_id = "acme";

    await updateClientFields("acme", { agent_ids: ["new_id_1", "new_id_2"] });

    // Old removed
    expect(mockAgentIdToClient.old_id).toBeUndefined();
    expect(mockAgentIdToSlug.old_id).toBeUndefined();
    // New registered
    expect(mockAgentIdToClient.new_id_1).toBe(existing);
    expect(mockAgentIdToClient.new_id_2).toBe(existing);
    expect(mockAgentIdToSlug.new_id_1).toBe("acme");
  });

  it("re-registers outbound_from_number when changed", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const existing = { agent_ids: [], outbound_from_number: "+15550000000" } as any;
    mockNotificationClients.acme = existing;
    mockPhoneNumberToClient["+15550000000"] = { slug: "acme", config: existing };

    await updateClientFields("acme", { outbound_from_number: "+15551111111" });

    expect(mockPhoneNumberToClient["+15550000000"]).toBeUndefined();
    expect(mockPhoneNumberToClient["+15551111111"]?.slug).toBe("acme");
  });

  it("works when client is not in memory cache (no in-memory side effects)", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    await expect(
      updateClientFields("not-cached", { name: "X" }),
    ).resolves.toBeUndefined();
  });
});

describe("softDeleteClient", () => {
  it("sets deletedAt and removes from caches", async () => {
    const existing = {
      agent_ids: ["agent_a"],
      outbound_from_number: "+15550001111",
    } as any;
    mockNotificationClients.acme = existing;
    mockAgentIdToClient.agent_a = existing;
    mockAgentIdToSlug.agent_a = "acme";
    mockPhoneNumberToClient["+15550001111"] = { slug: "acme", config: existing };
    mockUpdateOne.mockResolvedValue({});

    await softDeleteClient("acme");

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "acme" },
      { $set: { deletedAt: expect.any(Date) } },
    );
    expect(mockNotificationClients.acme).toBeUndefined();
    expect(mockAgentIdToClient.agent_a).toBeUndefined();
    expect(mockAgentIdToSlug.agent_a).toBeUndefined();
    expect(mockPhoneNumberToClient["+15550001111"]).toBeUndefined();
  });
});

describe("restoreClient", () => {
  it("unsets deletedAt and re-registers in memory", async () => {
    mockUpdateOne.mockResolvedValue({});
    mockFindOne.mockResolvedValue(makeDoc({ agent_ids: ["agent_a"] }));

    await restoreClient("acme");

    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "acme" },
      { $unset: { deletedAt: "" } },
    );
    expect(mockNotificationClients.acme).toBeDefined();
    expect(mockAgentIdToClient.agent_a).toBeDefined();
  });

  it("does not re-register if doc was deleted between unset and read", async () => {
    mockUpdateOne.mockResolvedValue({});
    mockFindOne.mockResolvedValue(null);

    await restoreClient("missing");

    expect(mockNotificationClients.missing).toBeUndefined();
  });
});

describe("listDeletedClients", () => {
  it("returns docs filtered by deletedAt: $exists", async () => {
    const items = [{ _id: "deleted1", name: "D1", deletedAt: new Date() }];
    mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue(items) });

    const result = await listDeletedClients();

    expect(mockFind).toHaveBeenCalledWith(
      { deletedAt: { $exists: true } },
      { projection: { _id: 1, name: 1, deletedAt: 1 } },
    );
    expect(result).toBe(items);
  });
});

describe("deleteClient", () => {
  it("unregisters from memory + deletes from db", async () => {
    const existing = { agent_ids: ["agent_x"], outbound_from_number: null } as any;
    mockNotificationClients.acme = existing;
    mockAgentIdToClient.agent_x = existing;
    mockAgentIdToSlug.agent_x = "acme";
    mockDeleteOne.mockResolvedValue({});

    await deleteClient("acme");

    expect(mockDeleteOne).toHaveBeenCalledWith({ _id: "acme" });
    expect(mockNotificationClients.acme).toBeUndefined();
    expect(mockAgentIdToClient.agent_x).toBeUndefined();
  });

  it("works even when client is not in memory", async () => {
    mockDeleteOne.mockResolvedValue({});
    await expect(deleteClient("not-cached")).resolves.toBeUndefined();
  });
});

describe("getClientDocument / getAllClientDocuments", () => {
  it("getClientDocument returns the doc by slug", async () => {
    const doc = makeDoc();
    mockFindOne.mockResolvedValue(doc);
    expect(await getClientDocument("acme")).toBe(doc);
    expect(mockFindOne).toHaveBeenCalledWith({ _id: "acme" });
  });

  it("getClientDocument returns null when missing", async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await getClientDocument("missing")).toBeNull();
  });

  it("getAllClientDocuments excludes soft-deleted", async () => {
    const docs = [makeDoc({ _id: "a" }), makeDoc({ _id: "b" })];
    mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue(docs) });

    const result = await getAllClientDocuments();

    expect(mockFind).toHaveBeenCalledWith({ deletedAt: { $exists: false } });
    expect(result).toBe(docs);
  });
});

describe("getAllClientSummaries", () => {
  it("returns summaries from in-memory cache", () => {
    mockNotificationClients.acme = {
      name: "Acme",
      agent_ids: ["agent_a"],
      shadow_mode: false,
    } as any;
    mockNotificationClients.beta = {
      name: "Beta",
      agent_ids: ["agent_b"],
      shadow_mode: true,
    } as any;

    const summaries = getAllClientSummaries();

    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.slug === "acme")).toEqual({
      slug: "acme",
      name: "Acme",
      shadow_mode: false,
      agent_ids: ["agent_a"],
    });
    expect(summaries.find((s) => s.slug === "beta")?.shadow_mode).toBe(true);
  });

  it("defaults shadow_mode to false when undefined", () => {
    mockNotificationClients.acme = {
      name: "Acme",
      agent_ids: [],
    } as any;
    expect(getAllClientSummaries()[0].shadow_mode).toBe(false);
  });

  it("returns empty array when no clients cached", () => {
    expect(getAllClientSummaries()).toEqual([]);
  });
});

describe("generatePortalToken", () => {
  it("generates a hex token and persists it", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });

    const token = await generatePortalToken("acme");

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: "acme" },
      { $set: { portal_token: token } },
    );
  });

  it("throws when client not found", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(generatePortalToken("missing")).rejects.toThrow(/not found/);
  });

  it("each call returns a different token", async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
    const a = await generatePortalToken("acme");
    const b = await generatePortalToken("acme");
    expect(a).not.toBe(b);
  });
});

describe("findClientsByEmail / validatePortalToken", () => {
  it("findClientsByEmail queries by dispatch_email", async () => {
    const items = [{ _id: "acme", name: "Acme", portal_token: "tok" }];
    mockFind.mockReturnValue({ toArray: vi.fn().mockResolvedValue(items) });

    const result = await findClientsByEmail("user@x.com");

    expect(mockFind).toHaveBeenCalledWith(
      { dispatch_email: "user@x.com" },
      { projection: { _id: 1, name: 1, portal_token: 1 } },
    );
    expect(result).toBe(items);
  });

  it("validatePortalToken returns true for matching token", async () => {
    mockFindOne.mockResolvedValue({ _id: "acme" });
    expect(await validatePortalToken("acme", "tok")).toBe(true);
    expect(mockFindOne).toHaveBeenCalledWith(
      { _id: "acme", portal_token: "tok" },
      { projection: { _id: 1 } },
    );
  });

  it("validatePortalToken returns false for non-matching token", async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await validatePortalToken("acme", "wrong")).toBe(false);
  });
});
