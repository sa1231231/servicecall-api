import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockPhoneNumberList } = vi.hoisted(() => ({
    mockPhoneNumberList: vi.fn(),
}));
vi.mock("retell-sdk", () => ({
    default: class MockRetell {
        phoneNumber = { list: mockPhoneNumberList };
    },
}));
vi.mock("../../../config.js", () => ({
    config: { RETELL_API_KEY: "test-key" },
}));
import { listPhoneNumbersHandler } from "../list-phone-numbers.js";
function mockReq() {
    return { params: {}, body: {}, query: {} };
}
function mockRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
beforeEach(() => {
    mockPhoneNumberList.mockReset();
});
describe("GET /dashboard/api/phone-numbers", () => {
    it("groups numbers by inbound_agents agent_id", async () => {
        mockPhoneNumberList.mockResolvedValue([
            {
                phone_number: "+18158804070",
                nickname: "Mosses Heating",
                inbound_agents: [{ agent_id: "agent_1", weight: 1 }],
            },
            {
                phone_number: "+15559990000",
                nickname: "Acme",
                inbound_agents: [{ agent_id: "agent_2", weight: 1 }],
            },
        ]);
        const res = mockRes();
        await listPhoneNumbersHandler(mockReq(), res);
        expect(res._json).toEqual({
            byAgent: {
                agent_1: [{ phone_number: "+18158804070", nickname: "Mosses Heating", role: "inbound" }],
                agent_2: [{ phone_number: "+15559990000", nickname: "Acme", role: "inbound" }],
            },
        });
    });
    it("multi-agent number appears under every bound agent", async () => {
        mockPhoneNumberList.mockResolvedValue([
            {
                phone_number: "+15551112222",
                nickname: null,
                inbound_agents: [
                    { agent_id: "agent_a", weight: 1 },
                    { agent_id: "agent_b", weight: 1 },
                ],
            },
        ]);
        const res = mockRes();
        await listPhoneNumbersHandler(mockReq(), res);
        expect(res._json.byAgent.agent_a).toEqual([
            { phone_number: "+15551112222", nickname: null, role: "inbound" },
        ]);
        expect(res._json.byAgent.agent_b).toEqual([
            { phone_number: "+15551112222", nickname: null, role: "inbound" },
        ]);
    });
    it("emits role=outbound for outbound_agents bindings without inbound", async () => {
        mockPhoneNumberList.mockResolvedValue([
            {
                phone_number: "+15553334444",
                nickname: "Outbound Only",
                inbound_agents: [],
                outbound_agents: [{ agent_id: "agent_o" }],
            },
        ]);
        const res = mockRes();
        await listPhoneNumbersHandler(mockReq(), res);
        expect(res._json.byAgent.agent_o).toEqual([
            { phone_number: "+15553334444", nickname: "Outbound Only", role: "outbound" },
        ]);
    });
    it("dedups when the same agent is bound both inbound and outbound (inbound wins)", async () => {
        mockPhoneNumberList.mockResolvedValue([
            {
                phone_number: "+15555556666",
                nickname: "Both",
                inbound_agents: [{ agent_id: "agent_x", weight: 1 }],
                outbound_agents: [{ agent_id: "agent_x" }],
            },
        ]);
        const res = mockRes();
        await listPhoneNumbersHandler(mockReq(), res);
        expect(res._json.byAgent.agent_x).toEqual([
            { phone_number: "+15555556666", nickname: "Both", role: "inbound" },
        ]);
    });
    it("returns 200 with error field when retell.phoneNumber.list throws", async () => {
        mockPhoneNumberList.mockRejectedValue(new Error("retell down"));
        const res = mockRes();
        await listPhoneNumbersHandler(mockReq(), res);
        expect(res._status).toBe(200);
        expect(res._json).toEqual({ byAgent: {}, error: "retell down" });
    });
    it("ignores numbers with no agent bindings", async () => {
        mockPhoneNumberList.mockResolvedValue([
            { phone_number: "+15557778888", nickname: "Unbound", inbound_agents: [] },
        ]);
        const res = mockRes();
        await listPhoneNumbersHandler(mockReq(), res);
        expect(res._json.byAgent).toEqual({});
    });
});
