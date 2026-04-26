import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockAvailableList, mockTwilioCreate, mockTrunkPhoneCreate, mockTrunkFetch, mockMsgPhoneCreate, mockRetellImport, } = vi.hoisted(() => ({
    mockAvailableList: vi.fn(),
    mockTwilioCreate: vi.fn(),
    mockTrunkPhoneCreate: vi.fn(),
    mockTrunkFetch: vi.fn(),
    mockMsgPhoneCreate: vi.fn(),
    mockRetellImport: vi.fn(),
}));
vi.mock("../../config.js", () => ({
    config: {
        TWILIO_ACCOUNT_SID: "ACtest",
        TWILIO_AUTH_TOKEN: "test_token",
        TWILIO_TRUNK_SID: "TK_test_trunk",
        TWILIO_EMERGENCY_ADDRESS_SID: "AD_test_address",
        TWILIO_MESSAGING_SERVICE_SID: "MG_test_service",
        RETELL_API_KEY: "retell_test_key",
    },
}));
vi.mock("twilio", () => ({
    default: () => ({
        availablePhoneNumbers: () => ({
            local: { list: mockAvailableList },
        }),
        incomingPhoneNumbers: { create: mockTwilioCreate },
        trunking: {
            v1: {
                trunks: () => ({
                    phoneNumbers: { create: mockTrunkPhoneCreate },
                    fetch: mockTrunkFetch,
                }),
            },
        },
        messaging: {
            v1: {
                services: () => ({
                    phoneNumbers: { create: mockMsgPhoneCreate },
                }),
            },
        },
    }),
}));
vi.mock("retell-sdk", () => ({
    default: class {
        phoneNumber = { import: mockRetellImport };
    },
}));
import { provisionPhoneNumber } from "../provision-number.js";
beforeEach(() => {
    vi.clearAllMocks();
    mockAvailableList.mockResolvedValue([
        { phoneNumber: "+13015551234" },
    ]);
    mockTwilioCreate.mockResolvedValue({
        sid: "PN_test_sid",
        phoneNumber: "+13015551234",
    });
    mockTrunkPhoneCreate.mockResolvedValue({});
    mockMsgPhoneCreate.mockResolvedValue({});
    mockTrunkFetch.mockResolvedValue({
        domainName: "test-trunk.pstn.twilio.com",
    });
    mockRetellImport.mockResolvedValue({
        phone_number: "+13015551234",
        phone_number_type: "custom",
    });
});
describe("provisionPhoneNumber", () => {
    const defaultOptions = {
        agentId: "agent_test123",
        clientName: "Test Company",
        dispatchCallNumber: "+13017872841",
    };
    it("completes full provisioning pipeline", async () => {
        const result = await provisionPhoneNumber(defaultOptions);
        expect(result.phoneNumber).toBe("+13015551234");
        expect(result.phoneNumberSid).toBe("PN_test_sid");
    });
    it("extracts area code from dispatch number", async () => {
        await provisionPhoneNumber(defaultOptions);
        expect(mockAvailableList).toHaveBeenCalledWith(expect.objectContaining({ areaCode: 301, limit: 1 }));
    });
    it("purchases number with emergency address", async () => {
        await provisionPhoneNumber(defaultOptions);
        expect(mockTwilioCreate).toHaveBeenCalledWith(expect.objectContaining({
            phoneNumber: "+13015551234",
            emergencyAddressSid: "AD_test_address",
        }));
    });
    it("adds number to SIP trunk", async () => {
        await provisionPhoneNumber(defaultOptions);
        expect(mockTrunkPhoneCreate).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberSid: "PN_test_sid" }));
    });
    it("adds number to messaging service", async () => {
        await provisionPhoneNumber(defaultOptions);
        expect(mockMsgPhoneCreate).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberSid: "PN_test_sid" }));
    });
    it("imports into Retell with agent binding", async () => {
        await provisionPhoneNumber(defaultOptions);
        expect(mockRetellImport).toHaveBeenCalledWith(expect.objectContaining({
            phone_number: "+13015551234",
            termination_uri: "test-trunk.pstn.twilio.com",
            inbound_agents: [{ agent_id: "agent_test123", weight: 1 }],
            nickname: "Test Company",
        }));
    });
    it("throws when no numbers available", async () => {
        mockAvailableList.mockResolvedValue([]);
        await expect(provisionPhoneNumber(defaultOptions)).rejects.toThrow("No available phone numbers in area code 301");
    });
    it("extracts area code from various formats", async () => {
        // +1AAANNNNNNN format
        await provisionPhoneNumber({ ...defaultOptions, dispatchCallNumber: "+18152073809" });
        expect(mockAvailableList).toHaveBeenCalledWith(expect.objectContaining({ areaCode: 815 }));
    });
    it("propagates Twilio purchase errors", async () => {
        mockTwilioCreate.mockRejectedValue(new Error("Insufficient funds"));
        await expect(provisionPhoneNumber(defaultOptions)).rejects.toThrow("Insufficient funds");
    });
    it("propagates Retell import errors", async () => {
        mockRetellImport.mockRejectedValue(new Error("Number already imported"));
        await expect(provisionPhoneNumber(defaultOptions)).rejects.toThrow("Number already imported");
    });
});
