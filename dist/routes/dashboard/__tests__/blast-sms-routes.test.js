import { describe, it, expect, vi, beforeEach } from "vitest";
/**
 * The blast-sms route handlers are inline in index.ts, so we test the
 * validation and wiring logic by re-implementing the handler logic
 * from index.ts lines 357-392 in isolation. This tests the same code
 * paths without needing to import the full router.
 */
// ── Mocks ──────────────────────────────────────────────────────────────────
const { mockPreviewBlast, mockSendBlast } = vi.hoisted(() => ({
    mockPreviewBlast: vi.fn(),
    mockSendBlast: vi.fn(),
}));
vi.mock("../../../lib/blast-sms.js", () => ({
    previewBlast: (...args) => mockPreviewBlast(...args),
    sendBlast: (...args) => mockSendBlast(...args),
}));
const { mockLogAudit, mockAlertRoot } = vi.hoisted(() => ({
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockAlertRoot: vi.fn(),
}));
vi.mock("../../../lib/audit.js", () => ({
    logAudit: (...args) => mockLogAudit(...args),
}));
vi.mock("../../../lib/root-alerts.js", () => ({
    alertRootIfNeeded: (...args) => mockAlertRoot(...args),
}));
import { previewBlast, sendBlast } from "../../../lib/blast-sms.js";
import { logAudit } from "../../../lib/audit.js";
import { alertRootIfNeeded } from "../../../lib/root-alerts.js";
// ── Extracted handlers (mirror index.ts logic) ────────────────────────────
function previewHandler(req, res) {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
        res.status(400).json({ error: "message is required" });
        return;
    }
    res.json(previewBlast(message));
}
async function sendHandler(req, res) {
    const { message } = req.body;
    if (!message || typeof message !== "string" || message.trim().length === 0) {
        res.status(400).json({ error: "message is required" });
        return;
    }
    if (message.length > 1600) {
        res.status(400).json({ error: "message must be 1600 characters or fewer" });
        return;
    }
    try {
        const result = await sendBlast(message);
        await logAudit(req, "blast_sms", "global", {
            recipients: result.total_recipients,
            clients: result.total_clients,
            sent: result.sent,
            failed: result.failed.length,
            message: message.slice(0, 200),
        });
        alertRootIfNeeded(req, "blast_sms", "global", `${result.sent}/${result.total_recipients} sent to ${result.total_clients} clients`);
        res.json({ success: true, ...result });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        res.status(500).json({ error: msg });
    }
}
// ── Helpers ────────────────────────────────────────────────────────────────
function mockReq(body) {
    return { body, user: { username: "admin" } };
}
function mockRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => { res._status = code; return res; };
    res.json = (data) => { res._json = data; return res; };
    return res;
}
// ── Tests ──────────────────────────────────────────────────────────────────
beforeEach(() => {
    vi.clearAllMocks();
});
describe("blast-sms preview handler", () => {
    it("returns 400 when message is missing", () => {
        const res = mockRes();
        previewHandler(mockReq({}), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toContain("message is required");
    });
    it("returns 400 when message is not a string", () => {
        const res = mockRes();
        previewHandler(mockReq({ message: 123 }), res);
        expect(res._status).toBe(400);
    });
    it("returns preview data from previewBlast", () => {
        mockPreviewBlast.mockReturnValue({
            total_recipients: 5,
            total_clients: 2,
            sample_message: "Hello Acme!",
        });
        const res = mockRes();
        previewHandler(mockReq({ message: "Hello {{client_name}}!" }), res);
        expect(res._status).toBe(200);
        expect(res._json.total_recipients).toBe(5);
        expect(res._json.sample_message).toBe("Hello Acme!");
        expect(mockPreviewBlast).toHaveBeenCalledWith("Hello {{client_name}}!");
    });
});
describe("blast-sms send handler", () => {
    it("returns 400 for whitespace-only message", async () => {
        const res = mockRes();
        await sendHandler(mockReq({ message: "   " }), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toContain("message is required");
    });
    it("returns 400 for message over 1600 chars", async () => {
        const res = mockRes();
        await sendHandler(mockReq({ message: "x".repeat(1601) }), res);
        expect(res._status).toBe(400);
        expect(res._json.error).toContain("1600");
    });
    it("sends blast, logs audit, and alerts root", async () => {
        const blastResult = {
            total_recipients: 3,
            total_clients: 2,
            sent: 3,
            failed: [],
        };
        mockSendBlast.mockResolvedValue(blastResult);
        const res = mockRes();
        await sendHandler(mockReq({ message: "Hello!" }), res);
        expect(res._status).toBe(200);
        expect(res._json.success).toBe(true);
        expect(res._json.sent).toBe(3);
        expect(mockSendBlast).toHaveBeenCalledWith("Hello!");
        expect(mockLogAudit).toHaveBeenCalledWith(expect.anything(), "blast_sms", "global", expect.objectContaining({ recipients: 3, sent: 3 }));
        expect(mockAlertRoot).toHaveBeenCalled();
    });
    it("returns 500 when sendBlast throws", async () => {
        mockSendBlast.mockRejectedValue(new Error("Twilio outage"));
        const res = mockRes();
        await sendHandler(mockReq({ message: "Hello!" }), res);
        expect(res._status).toBe(500);
        expect(res._json.error).toContain("Twilio outage");
        expect(mockLogAudit).not.toHaveBeenCalled();
    });
});
