import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockPhoneList, mockCreatePhoneCall } = vi.hoisted(() => ({
    mockPhoneList: vi.fn(),
    mockCreatePhoneCall: vi.fn(),
}));
vi.mock("../../config.js", () => ({
    config: { RETELL_API_KEY: "retell_test" },
}));
vi.mock("retell-sdk", () => ({
    default: class {
        phoneNumber = { list: mockPhoneList };
        call = { createPhoneCall: mockCreatePhoneCall };
    },
}));
const { triggerDispatchCall } = await import("../dispatch-call.js");
function makeClient(overrides = {}) {
    return {
        name: "Test Client",
        dispatch_call_number: "+15550009999",
        summary_agent_id: "agent_summary_1",
        ...overrides,
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    mockPhoneList.mockResolvedValue([
        {
            phone_number: "+15550001111",
            outbound_agents: [{ agent_id: "agent_summary_1" }],
        },
    ]);
    mockCreatePhoneCall.mockResolvedValue({ call_id: "call_abc" });
});
describe("triggerDispatchCall", () => {
    it("creates a phone call with the resolved from-number, dispatch number, and dynamic vars", async () => {
        await triggerDispatchCall(makeClient(), { x: "1", y: "two" });
        expect(mockCreatePhoneCall).toHaveBeenCalledWith({
            from_number: "+15550001111",
            to_number: "+15550009999",
            override_agent_id: "agent_summary_1",
            retell_llm_dynamic_variables: { x: "1", y: "two" },
        });
    });
    it("returns silently when dispatch_call_number is missing", async () => {
        await triggerDispatchCall(makeClient({ dispatch_call_number: undefined }), {});
        expect(mockPhoneList).not.toHaveBeenCalled();
        expect(mockCreatePhoneCall).not.toHaveBeenCalled();
    });
    it("returns silently when summary_agent_id is missing", async () => {
        await triggerDispatchCall(makeClient({ summary_agent_id: undefined }), {});
        expect(mockPhoneList).not.toHaveBeenCalled();
        expect(mockCreatePhoneCall).not.toHaveBeenCalled();
    });
    it("skips the call when no phone number is bound to the summary agent", async () => {
        mockPhoneList.mockResolvedValue([
            { phone_number: "+15550009999", outbound_agents: [{ agent_id: "agent_other" }] },
        ]);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        await triggerDispatchCall(makeClient(), {});
        expect(mockCreatePhoneCall).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("no associated phone number"));
        warn.mockRestore();
    });
    it("resolves phone via outbound_agents array entry", async () => {
        mockPhoneList.mockResolvedValue([
            {
                phone_number: "+15551112222",
                outbound_agents: [{ agent_id: "agent_summary_1" }],
            },
        ]);
        await triggerDispatchCall(makeClient(), {});
        expect(mockCreatePhoneCall).toHaveBeenCalledWith(expect.objectContaining({ from_number: "+15551112222" }));
    });
    it("resolves phone via inbound_agents array entry", async () => {
        mockPhoneList.mockResolvedValue([
            {
                phone_number: "+15553334444",
                inbound_agents: [{ agent_id: "agent_summary_1" }],
            },
        ]);
        await triggerDispatchCall(makeClient(), {});
        expect(mockCreatePhoneCall).toHaveBeenCalledWith(expect.objectContaining({ from_number: "+15553334444" }));
    });
    it("swallows Retell errors and logs them (does not throw)", async () => {
        mockCreatePhoneCall.mockRejectedValue(new Error("retell-down"));
        const err = vi.spyOn(console, "error").mockImplementation(() => { });
        await expect(triggerDispatchCall(makeClient(), {})).resolves.toBeUndefined();
        expect(err).toHaveBeenCalledWith(expect.stringContaining("retell-down"));
        err.mockRestore();
    });
});
