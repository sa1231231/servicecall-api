import { describe, it, expect, vi, beforeEach } from "vitest";
// Mock sendSms and sendEmail before importing
vi.mock("../notify-sms.js", () => ({
    sendSms: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../notify-email.js", () => ({
    sendEmail: vi.fn().mockResolvedValue(undefined),
}));
import { alertRootIfNeeded } from "../root-alerts.js";
import { sendSms } from "../notify-sms.js";
import { sendEmail } from "../notify-email.js";
function mockReq(user) {
    return { user, ip: "1.2.3.4" };
}
beforeEach(() => {
    vi.clearAllMocks();
});
describe("alertRootIfNeeded", () => {
    it("skips alert when user is root", async () => {
        alertRootIfNeeded(mockReq({ username: "admin", role: "admin", permissions: {}, isRoot: true }), "delete_agent", "test-slug");
        // Give fire-and-forget a tick
        await new Promise((r) => setTimeout(r, 10));
        expect(sendSms).not.toHaveBeenCalled();
        expect(sendEmail).not.toHaveBeenCalled();
    });
    it("skips alert when no user on request", async () => {
        alertRootIfNeeded(mockReq(), "delete_agent", "test-slug");
        await new Promise((r) => setTimeout(r, 10));
        expect(sendSms).not.toHaveBeenCalled();
        expect(sendEmail).not.toHaveBeenCalled();
    });
    it("sends SMS and email for non-root user", async () => {
        alertRootIfNeeded(mockReq({ username: "sam", role: "admin", permissions: {}, isRoot: false }), "delete_agent", "acme-plumbing");
        await new Promise((r) => setTimeout(r, 10));
        expect(sendSms).toHaveBeenCalledTimes(1);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const smsCall = sendSms.mock.calls[0];
        expect(smsCall[1]).toContain("sam");
        expect(smsCall[1]).toContain("delete_agent");
        expect(smsCall[1]).toContain("acme-plumbing");
        const emailCall = sendEmail.mock.calls[0][0];
        expect(emailCall.subject).toContain("delete_agent");
        expect(emailCall.subject).toContain("sam");
        expect(emailCall.body).toContain("acme-plumbing");
    });
    it("sends alert for operator performing action", async () => {
        alertRootIfNeeded(mockReq({ username: "jess", role: "operator", permissions: {}, isRoot: false }), "update_settings", "global", "owner_email, owner_phone");
        await new Promise((r) => setTimeout(r, 10));
        expect(sendSms).toHaveBeenCalledTimes(1);
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailCall = sendEmail.mock.calls[0][0];
        expect(emailCall.body).toContain("owner_email, owner_phone");
    });
    it("sends alert for viewer (if they somehow have permission)", async () => {
        alertRootIfNeeded(mockReq({ username: "va", role: "viewer", permissions: {}, isRoot: false }), "create_data_point", "lot_number");
        await new Promise((r) => setTimeout(r, 10));
        expect(sendSms).toHaveBeenCalledTimes(1);
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });
    it("does not throw when SMS/email fails", async () => {
        sendSms.mockRejectedValueOnce(new Error("Twilio down"));
        sendEmail.mockRejectedValueOnce(new Error("Resend down"));
        // Should not throw
        alertRootIfNeeded(mockReq({ username: "sam", role: "admin", permissions: {}, isRoot: false }), "delete_agent", "test");
        await new Promise((r) => setTimeout(r, 10));
        // Errors caught internally, no exception
    });
});
