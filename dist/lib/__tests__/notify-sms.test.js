import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockMessagesCreate } = vi.hoisted(() => ({
    mockMessagesCreate: vi.fn(),
}));
vi.mock("../../config.js", () => ({
    config: {
        TWILIO_ACCOUNT_SID: "ACtest",
        TWILIO_AUTH_TOKEN: "token",
        TWILIO_PHONE_NUMBER: "+15550000000",
    },
}));
vi.mock("twilio", () => ({
    default: () => ({
        messages: { create: mockMessagesCreate },
    }),
}));
// Stub retry so failures don't get retried during tests (faster, deterministic).
vi.mock("../retry.js", () => ({
    withRetry: (fn) => fn(),
}));
const { sendSms, sendSmsToAll } = await import("../notify-sms.js");
beforeEach(() => {
    vi.clearAllMocks();
    mockMessagesCreate.mockResolvedValue({ sid: "SM_test" });
});
describe("sendSms", () => {
    it("calls twilio messages.create with to/from/body", async () => {
        const result = await sendSms("+15551112222", "hello");
        expect(mockMessagesCreate).toHaveBeenCalledWith({
            to: "+15551112222",
            from: "+15550000000",
            body: "hello",
        });
        expect(result.sid).toBe("SM_test");
    });
    it("propagates errors from twilio", async () => {
        mockMessagesCreate.mockRejectedValue(new Error("twilio down"));
        await expect(sendSms("+15551112222", "hi")).rejects.toThrow("twilio down");
    });
});
describe("sendSmsToAll", () => {
    it("sends to each number and resolves on full success", async () => {
        const results = await sendSmsToAll(["+15550000001", "+15550000002"], "broadcast");
        expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
        expect(mockMessagesCreate).toHaveBeenCalledWith(expect.objectContaining({ to: "+15550000001" }));
        expect(mockMessagesCreate).toHaveBeenCalledWith(expect.objectContaining({ to: "+15550000002" }));
        expect(results).toHaveLength(2);
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    });
    it("aggregates partial failures into a single thrown error", async () => {
        mockMessagesCreate
            .mockResolvedValueOnce({ sid: "SM_ok" })
            .mockRejectedValueOnce(new Error("invalid number"));
        await expect(sendSmsToAll(["+15550000001", "+15550000002"], "msg")).rejects.toThrow(/invalid number/);
    });
    it("does not abort siblings — a failed send still allows the other to complete", async () => {
        mockMessagesCreate
            .mockRejectedValueOnce(new Error("fail"))
            .mockResolvedValueOnce({ sid: "SM_ok" });
        await sendSmsToAll(["+15550000001", "+15550000002"], "msg").catch(() => { });
        expect(mockMessagesCreate).toHaveBeenCalledTimes(2);
    });
    it("no-op for empty number list", async () => {
        const results = await sendSmsToAll([], "msg");
        expect(mockMessagesCreate).not.toHaveBeenCalled();
        expect(results).toEqual([]);
    });
    it("aggregates multiple failures with a separator", async () => {
        mockMessagesCreate.mockRejectedValue(new Error("down"));
        const promise = sendSmsToAll(["+15550000001", "+15550000002"], "msg");
        await expect(promise).rejects.toThrow(/down.*down/s);
    });
});
