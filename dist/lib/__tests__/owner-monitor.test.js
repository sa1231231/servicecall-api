import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
const { mockRetellRetrieve, mockSendEmail, mockSendSms, mockEnrichCallLog } = vi.hoisted(() => ({
    mockRetellRetrieve: vi.fn(),
    mockSendEmail: vi.fn(),
    mockSendSms: vi.fn(),
    mockEnrichCallLog: vi.fn(),
}));
vi.mock("../../config.js", () => ({
    config: { RETELL_API_KEY: "retell_test" },
}));
vi.mock("retell-sdk", () => ({
    default: class {
        call = { retrieve: mockRetellRetrieve };
    },
}));
vi.mock("../notify-email.js", () => ({
    sendEmail: (...args) => mockSendEmail(...args),
}));
vi.mock("../notify-sms.js", () => ({
    sendSms: (...args) => mockSendSms(...args),
}));
vi.mock("../call-log.js", () => ({
    enrichCallLog: (...args) => mockEnrichCallLog(...args),
}));
const { sendOwnerCallMonitor } = await import("../owner-monitor.js");
function makeClient(overrides = {}) {
    return {
        name: "Acme",
        agent_id: "agent_1",
        dispatch_text_numbers: [],
        dispatch_call_number: null,
        summary_agent_id: null,
        outbound_from_number: null,
        dispatch_email: null,
        dispatch_cc: null,
        resolve_type: () => "default",
        message_types: {},
        default_message_type: "default",
        ...overrides,
    };
}
function makeCall(overrides = {}) {
    return {
        call_id: "call_x1",
        from_number: "+15550001111",
        duration_ms: 65_000,
        disconnection_reason: "user_hangup",
        transcript: "Agent: Hello.\nUser: Hi.",
        recording_url: "https://rec.example/abc",
        public_log_url: "https://log.example/abc",
        call_analysis: {
            call_summary: "Brief summary",
            user_sentiment: "Positive",
            call_successful: true,
            in_voicemail: false,
        },
        ...overrides,
    };
}
beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockRetellRetrieve.mockResolvedValue(makeCall());
    mockSendEmail.mockResolvedValue({ id: "rs_1" });
    mockSendSms.mockResolvedValue({ sid: "SM_1" });
    mockEnrichCallLog.mockResolvedValue(undefined);
});
afterEach(() => {
    vi.useRealTimers();
});
async function runWithTimers(fn) {
    const promise = fn();
    await vi.runAllTimersAsync();
    return promise;
}
describe("sendOwnerCallMonitor — gating", () => {
    it("skips clients whose name contains 'Test'", async () => {
        await runWithTimers(() => sendOwnerCallMonitor(makeCall(), makeClient({ name: "Test Client" }), "dispatched"));
        expect(mockSendEmail).not.toHaveBeenCalled();
        expect(mockSendSms).not.toHaveBeenCalled();
        expect(mockRetellRetrieve).not.toHaveBeenCalled();
    });
});
describe("sendOwnerCallMonitor — happy path (non-problem call)", () => {
    it("sends an OK monitor email but no SMS for a positive sentiment success call", async () => {
        await runWithTimers(() => sendOwnerCallMonitor(makeCall(), makeClient(), "dispatched"));
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(mockSendSms).not.toHaveBeenCalled();
        const emailArgs = mockSendEmail.mock.calls[0][0];
        expect(emailArgs.subject).toContain("[Monitor]");
        expect(emailArgs.subject).toContain("Acme");
        expect(emailArgs.subject).toContain("1:05"); // 65s formatted
        expect(emailArgs.subject).toContain("Positive");
        expect(emailArgs.html).toContain("OK");
        expect(emailArgs.body).toContain("OK — Acme");
    });
    it("enriches the call log with analysis data before sending email", async () => {
        await runWithTimers(() => sendOwnerCallMonitor(makeCall(), makeClient(), "dispatched"));
        expect(mockEnrichCallLog).toHaveBeenCalledWith("call_x1", expect.objectContaining({
            call_summary: "Brief summary",
            user_sentiment: "Positive",
            call_successful: true,
            in_voicemail: false,
        }));
    });
    it("fetches enriched call data from Retell after the analysis delay", async () => {
        await runWithTimers(() => sendOwnerCallMonitor(makeCall(), makeClient(), "dispatched"));
        expect(mockRetellRetrieve).toHaveBeenCalledWith("call_x1");
    });
    it("falls back to webhook data when Retell retrieve throws", async () => {
        mockRetellRetrieve.mockRejectedValue(new Error("retell-down"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => { });
        await runWithTimers(() => sendOwnerCallMonitor(makeCall(), makeClient(), "dispatched"));
        expect(mockSendEmail).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("retell-down"));
        warn.mockRestore();
    });
});
describe("sendOwnerCallMonitor — problem path", () => {
    it("flags negative sentiment as problem and sends SMS alert", async () => {
        const problemCall = makeCall({
            call_analysis: { user_sentiment: "Negative", call_successful: true, in_voicemail: false, call_summary: "Bad" },
        });
        mockRetellRetrieve.mockResolvedValue(problemCall);
        await runWithTimers(() => sendOwnerCallMonitor(problemCall, makeClient(), "dispatched"));
        expect(mockSendSms).toHaveBeenCalledTimes(1);
        expect(mockSendSms.mock.calls[0][1]).toContain("[ALERT] Acme");
        const emailArgs = mockSendEmail.mock.calls[0][0];
        expect(emailArgs.subject.startsWith("[ALERT]")).toBe(true);
        expect(emailArgs.html).toContain("PROBLEM");
    });
    it("flags call_successful=false as problem", async () => {
        const c = makeCall({ call_analysis: { call_successful: false, user_sentiment: "Neutral", call_summary: "" } });
        mockRetellRetrieve.mockResolvedValue(c);
        await runWithTimers(() => sendOwnerCallMonitor(c, makeClient(), "dispatched"));
        expect(mockSendSms).toHaveBeenCalled();
    });
    it("flags voicemail as problem", async () => {
        const c = makeCall({ call_analysis: { in_voicemail: true, user_sentiment: "Neutral", call_summary: "" } });
        mockRetellRetrieve.mockResolvedValue(c);
        await runWithTimers(() => sendOwnerCallMonitor(c, makeClient(), "dispatched"));
        expect(mockSendSms).toHaveBeenCalled();
    });
    it("flags error_ disconnection reasons as problem", async () => {
        const c = makeCall({
            disconnection_reason: "error_no_audio_received",
            call_analysis: { user_sentiment: "Positive", call_successful: true, in_voicemail: false, call_summary: "" },
        });
        mockRetellRetrieve.mockResolvedValue(c);
        await runWithTimers(() => sendOwnerCallMonitor(c, makeClient(), "dispatched"));
        expect(mockSendSms).toHaveBeenCalled();
        const subj = mockSendEmail.mock.calls[0][0].subject;
        expect(subj).toContain("error_no_audio_received");
    });
});
describe("sendOwnerCallMonitor — formatting", () => {
    it("formats sub-minute durations correctly", async () => {
        const shortCall = makeCall({ duration_ms: 7000 });
        mockRetellRetrieve.mockResolvedValue(shortCall);
        await runWithTimers(() => sendOwnerCallMonitor(shortCall, makeClient(), "dispatched"));
        expect(mockSendEmail.mock.calls[0][0].subject).toContain("0:07");
    });
    it("escapes HTML in client name and call data", async () => {
        const call = makeCall({ from_number: "+1<script>" });
        const client = makeClient({ name: "<bad>Name</bad>" });
        await runWithTimers(() => sendOwnerCallMonitor(call, client, "dispatched"));
        const html = mockSendEmail.mock.calls[0][0].html;
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
        expect(html).toContain("&lt;bad&gt;");
    });
    it("includes the notification outcome in both subject metadata and body", async () => {
        await runWithTimers(() => sendOwnerCallMonitor(makeCall(), makeClient(), "skipped_required_field"));
        const args = mockSendEmail.mock.calls[0][0];
        expect(args.html).toContain("skipped_required_field");
        expect(args.body).toContain("skipped_required_field");
    });
    it("omits links section when no recording or log url is present", async () => {
        mockRetellRetrieve.mockResolvedValue(makeCall({ recording_url: null, public_log_url: null }));
        await runWithTimers(() => sendOwnerCallMonitor(makeCall({ recording_url: null, public_log_url: null }), makeClient(), "dispatched"));
        const html = mockSendEmail.mock.calls[0][0].html;
        expect(html).not.toContain("Recording");
        expect(html).not.toContain("Retell Logs");
    });
});
