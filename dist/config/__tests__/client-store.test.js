import { describe, it, expect, vi, beforeEach } from "vitest";
import { ruleToFunction, toClientConfig } from "../client-store.js";
// ── ruleToFunction ──────────────────────────────────────────────────────────
describe("ruleToFunction", () => {
    it("returns defaultType when no rules provided", () => {
        const fn = ruleToFunction(undefined, undefined, "fallback");
        expect(fn({})).toBe("fallback");
        expect(fn({ anything: "value" })).toBe("fallback");
    });
    it("resolves binary rule — then branch", () => {
        const rule = {
            field: "is_emergency",
            equals: "true",
            then: "emergency",
            else: "service_request",
        };
        const fn = ruleToFunction(rule, undefined, "service_request");
        expect(fn({ is_emergency: "true" })).toBe("emergency");
    });
    it("resolves binary rule — else branch", () => {
        const rule = {
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
        const rules = [
            { field: "path", equals: "Residential", then: "residential" },
            { field: "path", equals: "Commercial", then: "commercial" },
        ];
        const fn = ruleToFunction(undefined, rules, "default");
        expect(fn({ path: "Residential" })).toBe("residential");
        expect(fn({ path: "Commercial" })).toBe("commercial");
    });
    it("returns defaultType when no multi-path rule matches", () => {
        const rules = [
            { field: "path", equals: "Residential", then: "residential" },
        ];
        const fn = ruleToFunction(undefined, rules, "default");
        expect(fn({ path: "Other" })).toBe("default");
        expect(fn({})).toBe("default");
    });
    it("multi-path rules take precedence over binary rule", () => {
        const rule = {
            field: "is_emergency",
            equals: "true",
            then: "emergency",
            else: "service_request",
        };
        const rules = [
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
    function makeEntry(overrides = {}) {
        return {
            name: "Test Co",
            agent_id: "agent_1",
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
        const config = toClientConfig(makeEntry({
            resolve_rule: {
                field: "is_emergency",
                equals: "true",
                then: "emergency",
                else: "service_request",
            },
        }));
        expect(config.resolve_type({ is_emergency: "true" })).toBe("emergency");
        expect(config.resolve_type({ is_emergency: "false" })).toBe("service_request");
    });
    it("wires up multi-path resolve_rules", () => {
        const config = toClientConfig(makeEntry({
            resolve_rules: [
                { field: "type", equals: "A", then: "type_a" },
                { field: "type", equals: "B", then: "type_b" },
            ],
        }));
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
const { mockFindOne, mockFind, mockReplaceOne, mockUpdateOne, mockDeleteOne, mockDeleteMany, mockNotificationClients, mockAgentIdToClient, mockAgentIdToSlug, mockPhoneNumberToClient, mockRetellAgentDelete, mockRetellFlowDelete, } = vi.hoisted(() => ({
    mockFindOne: vi.fn(),
    mockFind: vi.fn(),
    mockReplaceOne: vi.fn(),
    mockUpdateOne: vi.fn(),
    mockDeleteOne: vi.fn(),
    mockDeleteMany: vi.fn(),
    mockNotificationClients: {},
    mockAgentIdToClient: {},
    mockAgentIdToSlug: {},
    mockPhoneNumberToClient: {},
    mockRetellAgentDelete: vi.fn(),
    mockRetellFlowDelete: vi.fn(),
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
// purgeExpiredClients does dynamic imports of retell-sdk + ../config.js.
vi.mock("retell-sdk", () => ({
    default: class {
        agent = { delete: mockRetellAgentDelete };
        conversationFlow = { delete: mockRetellFlowDelete };
    },
}));
vi.mock("../../config.js", () => ({
    config: { RETELL_API_KEY: "test_key" },
}));
// Mock release-agent-resources so purgeExpiredClients delegates to a stub
// that re-emits the same Retell calls + warn-format the tests assert on.
// (The helper itself has its own dedicated test file with full coverage.)
vi.mock("../../lib/release-agent-resources.js", () => ({
    releaseAgentResources: async (_slug, doc, logTag = "release-agent") => {
        // Simulate the helper's per-resource try/catch + warn behavior so the
        // existing log-format assertions in this test file keep their meaning.
        const errors = [];
        const retellAgents = doc.retell_agents ?? {};
        for (const [agentId, agentJson] of Object.entries(retellAgents)) {
            try {
                await mockRetellAgentDelete(agentId);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[${logTag}] retell.agent.delete(${agentId}): ${msg}`);
                errors.push(`retell.agent.delete(${agentId}): ${msg}`);
            }
            const flowId = agentJson?.conversationFlow?.conversation_flow_id ??
                agentJson?.response_engine?.conversation_flow_id;
            if (flowId) {
                try {
                    await mockRetellFlowDelete(flowId);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[${logTag}] retell.conversationFlow.delete(${flowId}): ${msg}`);
                    errors.push(`retell.conversationFlow.delete(${flowId}): ${msg}`);
                }
            }
        }
        if (doc.agent_id && !retellAgents[doc.agent_id]) {
            try {
                await mockRetellAgentDelete(doc.agent_id);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[${logTag}] retell.agent.delete(${doc.agent_id}): ${msg}`);
                errors.push(`retell.agent.delete(${doc.agent_id}): ${msg}`);
            }
        }
        return { released: [], errors };
    },
}));
const { loadClientsFromDb, persistClient, updateClientField, updateClientFields, softDeleteClient, restoreClient, listDeletedClients, deleteClient, getClientDocument, getAllClientDocuments, getAllClientSummaries, generatePortalToken, findClientsByEmail, validatePortalToken, purgeExpiredClients, } = await import("../client-store.js");
function chainable(items) {
    return {
        sort: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(items),
    };
}
function clearCaches() {
    for (const k of Object.keys(mockNotificationClients))
        delete mockNotificationClients[k];
    for (const k of Object.keys(mockAgentIdToClient))
        delete mockAgentIdToClient[k];
    for (const k of Object.keys(mockAgentIdToSlug))
        delete mockAgentIdToSlug[k];
    for (const k of Object.keys(mockPhoneNumberToClient))
        delete mockPhoneNumberToClient[k];
}
function makeDoc(overrides = {}) {
    return {
        _id: "acme",
        name: "Acme",
        agent_id: "agent_a",
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
            makeDoc({ _id: "a", agent_id: "agent_a", outbound_from_number: "+15551111111" }),
            makeDoc({ _id: "b", agent_id: "agent_b" }),
        ]));
        await loadClientsFromDb();
        expect(mockNotificationClients.a).toBeDefined();
        expect(mockNotificationClients.b).toBeDefined();
        expect(mockAgentIdToClient.agent_a).toBeDefined();
        expect(mockAgentIdToClient.agent_b).toBeDefined();
        expect(mockAgentIdToSlug.agent_a).toBe("a");
        expect(mockAgentIdToSlug.agent_b).toBe("b");
        expect(mockPhoneNumberToClient["+15551111111"]?.slug).toBe("a");
    });
    it("excludes soft-deleted docs (filter by deletedAt: $exists: false)", async () => {
        mockFind.mockReturnValue(chainable([]));
        await loadClientsFromDb();
        expect(mockFind).toHaveBeenCalledWith({ deletedAt: { $exists: false } });
    });
    it("skips docs with missing agent_id", async () => {
        mockFind.mockReturnValue(chainable([
            { _id: "broken", name: "Broken" }, // no agent_id
        ]));
        const log = vi.spyOn(console, "log").mockImplementation(() => { });
        await loadClientsFromDb();
        expect(mockNotificationClients.broken).toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.stringContaining("missing agent_id"));
        log.mockRestore();
    });
});
describe("persistClient", () => {
    it("upserts via replaceOne and stamps last_deployed_at", async () => {
        mockReplaceOne.mockResolvedValue({});
        const before = Date.now();
        const entry = makeDoc({ _id: undefined });
        delete entry._id;
        const config = await persistClient("acme", entry);
        expect(mockReplaceOne).toHaveBeenCalledWith({ _id: "acme" }, expect.objectContaining({ _id: "acme" }), { upsert: true });
        expect(typeof entry.last_deployed_at).toBe("string");
        expect(new Date(entry.last_deployed_at).getTime()).toBeGreaterThanOrEqual(before);
        // In-memory registered
        expect(mockNotificationClients.acme).toBeDefined();
        expect(config.name).toBe("Acme");
    });
});
describe("updateClientField", () => {
    it("updates a single field and reflects change in memory", async () => {
        mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
        mockNotificationClients.acme = { name: "Old" };
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
        await expect(updateClientFields("acme", { secret_field: "haxx" })).rejects.toThrow(/not editable/);
        expect(mockUpdateOne).not.toHaveBeenCalled();
    });
    it("rejects empty updates", async () => {
        await expect(updateClientFields("acme", {})).rejects.toThrow(/No valid fields/);
    });
    it("throws when matchedCount is 0", async () => {
        mockUpdateOne.mockResolvedValue({ matchedCount: 0 });
        await expect(updateClientFields("acme", { dispatch_call_number: "+15551234567" })).rejects.toThrow(/not found/);
    });
    it("rejects `name` updates so renames must go through rename-business", async () => {
        await expect(updateClientFields("acme", { name: "New Name" })).rejects.toThrow(/not editable/);
        expect(mockUpdateOne).not.toHaveBeenCalled();
    });
    it("re-registers agent_id when it changes", async () => {
        mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
        const existing = { name: "Acme", agent_id: "old_id", outbound_from_number: null };
        mockNotificationClients.acme = existing;
        mockAgentIdToClient.old_id = existing;
        mockAgentIdToSlug.old_id = "acme";
        await updateClientFields("acme", { agent_id: "new_id" });
        // Old removed
        expect(mockAgentIdToClient.old_id).toBeUndefined();
        expect(mockAgentIdToSlug.old_id).toBeUndefined();
        // New registered
        expect(mockAgentIdToClient.new_id).toBe(existing);
        expect(mockAgentIdToSlug.new_id).toBe("acme");
    });
    it("re-registers outbound_from_number when changed", async () => {
        mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
        const existing = { agent_id: "", outbound_from_number: "+15550000000" };
        mockNotificationClients.acme = existing;
        mockPhoneNumberToClient["+15550000000"] = { slug: "acme", config: existing };
        await updateClientFields("acme", { outbound_from_number: "+15551111111" });
        expect(mockPhoneNumberToClient["+15550000000"]).toBeUndefined();
        expect(mockPhoneNumberToClient["+15551111111"]?.slug).toBe("acme");
    });
    it("works when client is not in memory cache (no in-memory side effects)", async () => {
        mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
        await expect(updateClientFields("not-cached", { dispatch_call_number: "+15551234567" })).resolves.toBeUndefined();
    });
});
describe("softDeleteClient", () => {
    it("sets deletedAt and removes from caches", async () => {
        const existing = {
            agent_id: "agent_a",
            outbound_from_number: "+15550001111",
        };
        mockNotificationClients.acme = existing;
        mockAgentIdToClient.agent_a = existing;
        mockAgentIdToSlug.agent_a = "acme";
        mockPhoneNumberToClient["+15550001111"] = { slug: "acme", config: existing };
        mockUpdateOne.mockResolvedValue({});
        await softDeleteClient("acme");
        expect(mockUpdateOne).toHaveBeenCalledWith({ _id: "acme" }, { $set: { deletedAt: expect.any(Date) } });
        expect(mockNotificationClients.acme).toBeUndefined();
        expect(mockAgentIdToClient.agent_a).toBeUndefined();
        expect(mockAgentIdToSlug.agent_a).toBeUndefined();
        expect(mockPhoneNumberToClient["+15550001111"]).toBeUndefined();
    });
});
describe("restoreClient", () => {
    it("unsets deletedAt and re-registers in memory", async () => {
        mockUpdateOne.mockResolvedValue({});
        mockFindOne.mockResolvedValue(makeDoc({ agent_id: "agent_a" }));
        await restoreClient("acme");
        expect(mockUpdateOne).toHaveBeenCalledWith({ _id: "acme" }, { $unset: { deletedAt: "" } });
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
        expect(mockFind).toHaveBeenCalledWith({ deletedAt: { $exists: true } }, { projection: { _id: 1, name: 1, deletedAt: 1 } });
        expect(result).toBe(items);
    });
});
describe("deleteClient", () => {
    it("unregisters from memory + deletes from db", async () => {
        const existing = { agent_id: "agent_x", outbound_from_number: null };
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
            agent_id: "agent_a",
            shadow_mode: false,
        };
        mockNotificationClients.beta = {
            name: "Beta",
            agent_id: "agent_b",
            shadow_mode: true,
        };
        const summaries = getAllClientSummaries();
        expect(summaries).toHaveLength(2);
        expect(summaries.find((s) => s.slug === "acme")).toEqual({
            slug: "acme",
            name: "Acme",
            shadow_mode: false,
            agent_id: "agent_a",
        });
        expect(summaries.find((s) => s.slug === "beta")?.shadow_mode).toBe(true);
    });
    it("defaults shadow_mode to false when undefined", () => {
        mockNotificationClients.acme = {
            name: "Acme",
            agent_id: "",
        };
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
        expect(mockUpdateOne).toHaveBeenCalledWith({ _id: "acme" }, { $set: { portal_token: token } });
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
        expect(mockFind).toHaveBeenCalledWith({ dispatch_email: "user@x.com" }, { projection: { _id: 1, name: 1, portal_token: 1 } });
        expect(result).toBe(items);
    });
    it("validatePortalToken returns true for matching token", async () => {
        mockFindOne.mockResolvedValue({ _id: "acme" });
        expect(await validatePortalToken("acme", "tok")).toBe(true);
        expect(mockFindOne).toHaveBeenCalledWith({ _id: "acme", portal_token: "tok" }, { projection: { _id: 1 } });
    });
    it("validatePortalToken returns false for non-matching token", async () => {
        mockFindOne.mockResolvedValue(null);
        expect(await validatePortalToken("acme", "wrong")).toBe(false);
    });
});
describe("purgeExpiredClients", () => {
    beforeEach(() => {
        mockRetellAgentDelete.mockResolvedValue({});
        mockRetellFlowDelete.mockResolvedValue({});
    });
    it("returns 0 and skips Retell when nothing is expired", async () => {
        mockFind.mockReturnValue(chainable([]));
        const count = await purgeExpiredClients();
        expect(count).toBe(0);
        expect(mockRetellAgentDelete).not.toHaveBeenCalled();
        expect(mockRetellFlowDelete).not.toHaveBeenCalled();
        expect(mockDeleteMany).not.toHaveBeenCalled();
    });
    it("queries with deletedAt < cutoff (default 30 days back)", async () => {
        mockFind.mockReturnValue(chainable([]));
        const before = Date.now();
        await purgeExpiredClients();
        const filter = mockFind.mock.calls[0][0];
        expect(filter.deletedAt).toBeDefined();
        const cutoff = filter.deletedAt.$lt;
        expect(cutoff).toBeInstanceOf(Date);
        // Cutoff should be ~30 days before "now"
        const cutoffMs = cutoff.getTime();
        const expectedMin = before - 30 * 86_400_000 - 1000;
        const expectedMax = before - 30 * 86_400_000 + 1000;
        expect(cutoffMs).toBeGreaterThanOrEqual(expectedMin);
        expect(cutoffMs).toBeLessThanOrEqual(expectedMax);
    });
    it("respects a custom days argument", async () => {
        mockFind.mockReturnValue(chainable([]));
        await purgeExpiredClients(7);
        const cutoff = mockFind.mock.calls[0][0].deletedAt.$lt;
        const cutoffMs = cutoff.getTime();
        const expected = Date.now() - 7 * 86_400_000;
        expect(Math.abs(cutoffMs - expected)).toBeLessThan(1500);
    });
    it("deletes Retell agents and flows for expired docs", async () => {
        mockFind.mockReturnValue(chainable([
            {
                _id: "old-1",
                agent_id: "agent_a",
                retell_agents: {
                    agent_a: {
                        conversationFlow: { conversation_flow_id: "cf_a" },
                    },
                },
            },
        ]));
        mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
        const count = await purgeExpiredClients();
        expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_a");
        expect(mockRetellFlowDelete).toHaveBeenCalledWith("cf_a");
        expect(mockDeleteMany).toHaveBeenCalledTimes(1);
        expect(count).toBe(1);
    });
    it("supports response_engine.conversation_flow_id when conversationFlow is missing", async () => {
        mockFind.mockReturnValue(chainable([
            {
                _id: "old-2",
                agent_id: "agent_b",
                retell_agents: {
                    agent_b: {
                        response_engine: { conversation_flow_id: "cf_b" },
                    },
                },
            },
        ]));
        mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
        await purgeExpiredClients();
        expect(mockRetellFlowDelete).toHaveBeenCalledWith("cf_b");
    });
    it("does NOT call flow delete when no flow id is present", async () => {
        mockFind.mockReturnValue(chainable([
            {
                _id: "no-flow",
                agent_id: "agent_x",
                retell_agents: { agent_x: {} },
            },
        ]));
        mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
        await purgeExpiredClients();
        expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_x");
        expect(mockRetellFlowDelete).not.toHaveBeenCalled();
    });
    it("deletes agent_id not present in retell_agents map (belt and suspenders)", async () => {
        mockFind.mockReturnValue(chainable([
            {
                _id: "extra-id",
                agent_id: "agent_not_in_map",
                retell_agents: {
                    agent_in_map: {},
                },
            },
        ]));
        mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
        await purgeExpiredClients();
        expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_in_map");
        expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_not_in_map");
        expect(mockRetellAgentDelete).toHaveBeenCalledTimes(2);
    });
    it("continues purging when an individual Retell agent delete throws", async () => {
        mockFind.mockReturnValue(chainable([
            {
                _id: "fail-agent",
                agent_id: "agent_x",
                retell_agents: {
                    agent_x: { conversationFlow: { conversation_flow_id: "cf_x" } },
                },
            },
        ]));
        mockRetellAgentDelete.mockRejectedValue(new Error("retell agent gone"));
        mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const count = await purgeExpiredClients();
        // Even if Retell agent delete fails, flow delete still runs and DB still purges.
        expect(mockRetellFlowDelete).toHaveBeenCalledWith("cf_x");
        expect(mockDeleteMany).toHaveBeenCalledTimes(1);
        expect(count).toBe(1);
        // Helper logs `[purge] retell.agent.delete(<id>): <msg>` on per-call failure.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("retell.agent.delete"));
        warn.mockRestore();
    });
    it("continues purging when an individual Retell flow delete throws", async () => {
        mockFind.mockReturnValue(chainable([
            {
                _id: "fail-flow",
                agent_id: "agent_y",
                retell_agents: {
                    agent_y: { conversationFlow: { conversation_flow_id: "cf_y" } },
                },
            },
        ]));
        mockRetellFlowDelete.mockRejectedValue(new Error("flow gone"));
        mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        const count = await purgeExpiredClients();
        expect(count).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("retell.conversationFlow.delete"));
        warn.mockRestore();
    });
    it("processes multiple expired clients independently", async () => {
        mockFind.mockReturnValue(chainable([
            { _id: "a", agent_id: "agent_a", retell_agents: { agent_a: {} } },
            { _id: "b", agent_id: "agent_b", retell_agents: { agent_b: {} } },
        ]));
        mockDeleteMany.mockResolvedValue({ deletedCount: 2 });
        const count = await purgeExpiredClients();
        expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_a");
        expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_b");
        expect(count).toBe(2);
    });
    it("uses the same cutoff for query and deleteMany", async () => {
        mockFind.mockReturnValue(chainable([
            { _id: "x", agent_id: "agent_x", retell_agents: { agent_x: {} } },
        ]));
        mockDeleteMany.mockResolvedValue({ deletedCount: 1 });
        await purgeExpiredClients(15);
        const findCutoff = mockFind.mock.calls[0][0].deletedAt.$lt;
        const deleteCutoff = mockDeleteMany.mock.calls[0][0].deletedAt.$lt;
        expect(deleteCutoff.getTime()).toBe(findCutoff.getTime());
    });
});
