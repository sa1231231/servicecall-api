import { describe, it, expect, vi, beforeEach } from "vitest";
// ── Shared mutable state for the mock ─────────────────────────────────────
const { callLogDocs } = vi.hoisted(() => ({ callLogDocs: [] }));
// ── Mocks ─────────────────────────────────────────────────────────────────
vi.mock("../db.js", () => ({
    getDb: () => ({
        collection: (name) => ({
            find: (filter) => ({
                toArray: async () => {
                    if (name !== "call_logs")
                        return [];
                    return callLogDocs.filter((d) => {
                        if (filter?.client_slug && d.client_slug !== filter.client_slug)
                            return false;
                        if (filter?.created_at) {
                            if (d.created_at < filter.created_at.$gte)
                                return false;
                            if (d.created_at >= filter.created_at.$lt)
                                return false;
                        }
                        return true;
                    });
                },
            }),
            findOne: async () => null,
            replaceOne: async () => ({ matchedCount: 1 }),
        }),
    }),
}));
vi.mock("../notify-email.js", () => ({
    sendEmail: vi.fn().mockResolvedValue({ id: "mock-email-id" }),
}));
vi.mock("../notify-sms.js", () => ({
    sendSmsToAll: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../config/client-store.js", () => ({
    getAllClientDocuments: vi.fn().mockResolvedValue([]),
}));
// ── Imports (after mocks) ─────────────────────────────────────────────────
import { sendEmail } from "../notify-email.js";
import { sendSmsToAll } from "../notify-sms.js";
import { sendWeeklyReportForClient } from "../weekly-report.js";
// ── Helpers ───────────────────────────────────────────────────────────────
function makeClientDoc(overrides = {}) {
    return {
        _id: "test-client",
        name: "Test Plumbing",
        agent_ids: ["agent_1"],
        dispatch_text_numbers: ["+15551234567"],
        dispatch_call_number: null,
        summary_agent_id: null,
        outbound_from_number: null,
        dispatch_email: ["dispatch@test.com"],
        dispatch_cc: null,
        message_types: {
            service_request: {
                label: "Service Request",
                subject_template: "SR: {{full_name}}",
                fields: [{ key: "full_name", label: "Name" }],
            },
            emergency: {
                label: "Emergency",
                subject_template: "EMERGENCY: {{full_name}}",
                fields: [{ key: "full_name", label: "Name" }],
            },
        },
        default_message_type: "service_request",
        shadow_mode: false,
        ...overrides,
    };
}
// Use a date 1 hour ago so it falls within the query's $gte/$lt range
const recentDate = () => new Date(Date.now() - 3_600_000);
beforeEach(() => {
    vi.clearAllMocks();
    callLogDocs.length = 0;
});
// ── Tests ─────────────────────────────────────────────────────────────────
describe("sendWeeklyReportForClient", () => {
    it("sends email and SMS with correct call counts", async () => {
        const ts = recentDate();
        callLogDocs.push({ client_slug: "test-client", message_type_key: "service_request", created_at: ts }, { client_slug: "test-client", message_type_key: "service_request", created_at: ts }, { client_slug: "test-client", message_type_key: "emergency", created_at: ts });
        await sendWeeklyReportForClient(makeClientDoc());
        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendSmsToAll).toHaveBeenCalledTimes(1);
        const emailCall = vi.mocked(sendEmail).mock.calls[0][0];
        expect(emailCall.to).toBe("dispatch@test.com");
        expect(emailCall.subject).toBe("Weekly Report \u2014 Test Plumbing");
        expect(emailCall.body).toContain("Total calls: 3");
        expect(emailCall.body).toContain("Service Request: 2");
        expect(emailCall.body).toContain("Emergency: 1");
        const smsNumbers = vi.mocked(sendSmsToAll).mock.calls[0][0];
        const smsBody = vi.mocked(sendSmsToAll).mock.calls[0][1];
        expect(smsNumbers).toEqual(["+15551234567"]);
        expect(smsBody).toContain("Total calls: 3");
    });
    it("sends to owner when shadow_mode is true", async () => {
        callLogDocs.push({ client_slug: "test-client", message_type_key: "service_request", created_at: recentDate() });
        await sendWeeklyReportForClient(makeClientDoc({ shadow_mode: true }));
        const emailCall = vi.mocked(sendEmail).mock.calls[0][0];
        expect(emailCall.to).toBe("samasra93@gmail.com");
        const smsNumbers = vi.mocked(sendSmsToAll).mock.calls[0][0];
        expect(smsNumbers).toEqual(["+13017872841"]);
    });
    it("sends report with zero calls", async () => {
        await sendWeeklyReportForClient(makeClientDoc());
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const emailCall = vi.mocked(sendEmail).mock.calls[0][0];
        expect(emailCall.body).toContain("Total calls: 0");
    });
    it("groups by message_type_key using client config labels", async () => {
        const ts = recentDate();
        callLogDocs.push({ client_slug: "test-client", message_type_key: "service_request", created_at: ts }, { client_slug: "test-client", message_type_key: "service_request", created_at: ts });
        await sendWeeklyReportForClient(makeClientDoc());
        const emailCall = vi.mocked(sendEmail).mock.calls[0][0];
        expect(emailCall.body).toContain("Service Request: 2");
        // Should use labels, not raw keys
        expect(emailCall.body).not.toMatch(/^service_request:/m);
    });
    it("counts unknown message_type_key as Other", async () => {
        callLogDocs.push({ client_slug: "test-client", message_type_key: "unknown_type", created_at: recentDate() });
        await sendWeeklyReportForClient(makeClientDoc());
        const emailCall = vi.mocked(sendEmail).mock.calls[0][0];
        expect(emailCall.body).toContain("Other: 1");
    });
    it("sends to multiple email recipients", async () => {
        await sendWeeklyReportForClient(makeClientDoc({ dispatch_email: ["a@test.com", "b@test.com"] }));
        expect(sendEmail).toHaveBeenCalledTimes(2);
        expect(vi.mocked(sendEmail).mock.calls[0][0].to).toBe("a@test.com");
        expect(vi.mocked(sendEmail).mock.calls[1][0].to).toBe("b@test.com");
    });
    it("completes without error (stores last_report_sent)", async () => {
        await expect(sendWeeklyReportForClient(makeClientDoc())).resolves.toBeUndefined();
    });
    it("skips SMS when no dispatch numbers", async () => {
        await sendWeeklyReportForClient(makeClientDoc({ dispatch_text_numbers: [] }));
        expect(sendSmsToAll).not.toHaveBeenCalled();
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });
    it("skips email when no dispatch emails", async () => {
        await sendWeeklyReportForClient(makeClientDoc({ dispatch_email: null }));
        expect(sendEmail).not.toHaveBeenCalled();
        expect(sendSmsToAll).toHaveBeenCalledTimes(1);
    });
    it("email contains HTML version", async () => {
        await sendWeeklyReportForClient(makeClientDoc());
        const emailCall = vi.mocked(sendEmail).mock.calls[0][0];
        expect(emailCall.html).toBeDefined();
        expect(emailCall.html).toContain("Weekly Report");
        expect(emailCall.html).toContain("Test Plumbing");
    });
    it("SMS format is shorter than email", async () => {
        callLogDocs.push({ client_slug: "test-client", message_type_key: "service_request", created_at: recentDate() });
        await sendWeeklyReportForClient(makeClientDoc());
        const emailBody = vi.mocked(sendEmail).mock.calls[0][0].body;
        const smsBody = vi.mocked(sendSmsToAll).mock.calls[0][1];
        expect(smsBody.length).toBeLessThan(emailBody.length);
        expect(smsBody).not.toContain("servicecallsaver.com");
        expect(emailBody).toContain("servicecallsaver.com");
    });
    it("only counts calls within the past 7 days", async () => {
        const recent = recentDate();
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600000);
        callLogDocs.push({ client_slug: "test-client", message_type_key: "service_request", created_at: recent }, { client_slug: "test-client", message_type_key: "service_request", created_at: eightDaysAgo });
        await sendWeeklyReportForClient(makeClientDoc());
        const emailCall = vi.mocked(sendEmail).mock.calls[0][0];
        expect(emailCall.body).toContain("Total calls: 1");
    });
});
