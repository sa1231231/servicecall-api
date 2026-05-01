import { describe, it, expect, vi, beforeEach } from "vitest";
// ── Mocks ──────────────────────────────────────────────────────────────────
const { mockPhoneNumberList, mockPhoneNumberUpdate } = vi.hoisted(() => ({
    mockPhoneNumberList: vi.fn(),
    mockPhoneNumberUpdate: vi.fn(),
}));
vi.mock("retell-sdk", () => ({
    default: class MockRetell {
        phoneNumber = {
            list: mockPhoneNumberList,
            update: mockPhoneNumberUpdate,
        };
    },
}));
vi.mock("../../../config.js", () => ({
    config: { RETELL_API_KEY: "test-key" },
}));
const { mockUpdateClientFields, mockNotificationClients } = vi.hoisted(() => ({
    mockUpdateClientFields: vi.fn(),
    mockNotificationClients: {},
}));
vi.mock("../../../config/client-store.js", () => ({
    updateClientFields: (...args) => mockUpdateClientFields(...args),
}));
vi.mock("../../../_cache/clients.js", () => ({
    notificationClients: mockNotificationClients,
}));
import { toggleActiveHandler } from "../toggle-active.js";
// ── Helpers ────────────────────────────────────────────────────────────────
function mockReq(slug, body) {
    return { params: { slug }, body };
}
function mockRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
function makeRetellNumber(phone, agentId) {
    return {
        phone_number: phone,
        inbound_agent_id: agentId ?? undefined,
        inbound_agents: agentId ? [{ agent_id: agentId, weight: 1 }] : undefined,
    };
}
// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateClientFields.mockResolvedValue(undefined);
    for (const k of Object.keys(mockNotificationClients))
        delete mockNotificationClients[k];
});
describe("toggleActiveHandler", () => {
    it("returns 400 when active is not a boolean", async () => {
        const res = mockRes();
        await toggleActiveHandler(mockReq("test", { active: "yes" }), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toContain("boolean");
    });
    it("returns 404 when client not found", async () => {
        const res = mockRes();
        await toggleActiveHandler(mockReq("nonexistent", { active: true }), res);
        expect(res._status).toBe(404);
        expect(res._json.error).toContain("not found");
    });
    describe("deactivation (active: false)", () => {
        it("clears inbound agents on matching phone numbers", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: "+15551234567",
            };
            mockPhoneNumberList.mockResolvedValue([
                makeRetellNumber("+15551234567", "agent_abc"),
                makeRetellNumber("+15559999999", "agent_other"),
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: false }), res);
            expect(res._json.success).toBe(true);
            expect(res._json.active).toBe(false);
            expect(res._json.numbers_updated).toBe(1);
            expect(mockPhoneNumberUpdate).toHaveBeenCalledWith("+15551234567", {
                inbound_agent_id: null,
                inbound_agents: null,
            });
        });
        it("stores deactivated_numbers in MongoDB", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: null,
            };
            mockPhoneNumberList.mockResolvedValue([
                makeRetellNumber("+15551111111", "agent_abc"),
                makeRetellNumber("+15552222222", "agent_abc"),
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: false }), res);
            expect(mockUpdateClientFields).toHaveBeenCalledWith("test-co", {
                active: false,
                deactivated_numbers: ["+15551111111", "+15552222222"],
            });
        });
        it("matches by outbound_from_number even when inbound agents already cleared", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: "+15551234567",
            };
            mockPhoneNumberList.mockResolvedValue([
                { phone_number: "+15551234567", inbound_agent_id: undefined, inbound_agents: undefined },
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: false }), res);
            expect(res._json.numbers_updated).toBe(1);
        });
        it("handles no matching phone numbers gracefully", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: null,
            };
            mockPhoneNumberList.mockResolvedValue([
                makeRetellNumber("+15559999999", "agent_other"),
            ]);
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: false }), res);
            expect(res._json.success).toBe(true);
            expect(res._json.numbers_updated).toBe(0);
            expect(mockPhoneNumberUpdate).not.toHaveBeenCalled();
        });
    });
    describe("reactivation (active: true)", () => {
        it("re-binds agent using stored deactivated_numbers", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: null,
                deactivated_numbers: ["+15551234567"],
            };
            mockPhoneNumberList.mockResolvedValue([
                { phone_number: "+15551234567", inbound_agent_id: undefined, inbound_agents: undefined },
                makeRetellNumber("+15559999999", "agent_other"),
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: true }), res);
            expect(res._json.success).toBe(true);
            expect(res._json.numbers_updated).toBe(1);
            expect(mockPhoneNumberUpdate).toHaveBeenCalledWith("+15551234567", {
                inbound_agents: [{ agent_id: "agent_abc", weight: 1 }],
            });
        });
        it("clears deactivated_numbers after reactivation", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: null,
                deactivated_numbers: ["+15551234567"],
            };
            mockPhoneNumberList.mockResolvedValue([
                { phone_number: "+15551234567" },
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: true }), res);
            expect(mockUpdateClientFields).toHaveBeenCalledWith("test-co", {
                active: true,
                deactivated_numbers: null,
            });
        });
        it("falls back to outbound_from_number when no stored numbers", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: "+15551234567",
            };
            mockPhoneNumberList.mockResolvedValue([
                { phone_number: "+15551234567", inbound_agent_id: undefined, inbound_agents: undefined },
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: true }), res);
            expect(res._json.numbers_updated).toBe(1);
            expect(mockPhoneNumberUpdate).toHaveBeenCalledWith("+15551234567", {
                inbound_agents: [{ agent_id: "agent_abc", weight: 1 }],
            });
        });
    });
    describe("edge cases", () => {
        it("reactivation with empty agent_ids does not update phone numbers", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: [],
                outbound_from_number: null,
                deactivated_numbers: ["+15551234567"],
            };
            mockPhoneNumberList.mockResolvedValue([
                { phone_number: "+15551234567" },
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: true }), res);
            expect(res._json.success).toBe(true);
            // No agentId to bind, so update is skipped
            expect(mockPhoneNumberUpdate).not.toHaveBeenCalled();
            expect(res._json.numbers_updated).toBe(0);
        });
        it("reactivation with multiple agent_ids only binds the first", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_first", "agent_second"],
                outbound_from_number: null,
                deactivated_numbers: ["+15551234567"],
            };
            mockPhoneNumberList.mockResolvedValue([
                { phone_number: "+15551234567" },
            ]);
            mockPhoneNumberUpdate.mockResolvedValue({});
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: true }), res);
            expect(mockPhoneNumberUpdate).toHaveBeenCalledWith("+15551234567", {
                inbound_agents: [{ agent_id: "agent_first", weight: 1 }],
            });
        });
        it("partial Retell failure skips MongoDB update", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: null,
            };
            mockPhoneNumberList.mockResolvedValue([
                makeRetellNumber("+15551111111", "agent_abc"),
                makeRetellNumber("+15552222222", "agent_abc"),
            ]);
            mockPhoneNumberUpdate
                .mockResolvedValueOnce({})
                .mockRejectedValueOnce(new Error("Rate limited"));
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: false }), res);
            expect(res._status).toBe(500);
            expect(res._json.details).toHaveLength(1);
            expect(res._json.details[0]).toContain("Rate limited");
            expect(mockUpdateClientFields).not.toHaveBeenCalled();
        });
    });
    describe("error handling", () => {
        it("returns 500 when Retell API fails", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: "+15551234567",
            };
            mockPhoneNumberList.mockResolvedValue([
                makeRetellNumber("+15551234567", "agent_abc"),
            ]);
            mockPhoneNumberUpdate.mockRejectedValue(new Error("Retell API error"));
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: false }), res);
            expect(res._status).toBe(500);
            expect(res._json.error).toContain("Failed to update");
            expect(res._json.details).toHaveLength(1);
            expect(mockUpdateClientFields).not.toHaveBeenCalled();
        });
        it("returns error when MongoDB update fails", async () => {
            mockNotificationClients["test-co"] = {
                agent_ids: ["agent_abc"],
                outbound_from_number: null,
            };
            mockPhoneNumberList.mockResolvedValue([]);
            mockUpdateClientFields.mockRejectedValue(new Error("DB error"));
            const res = mockRes();
            await toggleActiveHandler(mockReq("test-co", { active: false }), res);
            expect(res._status).toBe(404);
            expect(res._json.error).toContain("DB error");
        });
    });
});
