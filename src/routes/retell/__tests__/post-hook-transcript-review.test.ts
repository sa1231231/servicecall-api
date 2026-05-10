// Locks the wiring between the post-hook and the transcript-review
// orchestrator. The existing post-hook.test.ts covers the dispatch /
// shadow / test-mode branches but never asserts that runTranscriptReview
// is invoked, with what args, or that it's fire-and-forget.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../../config.js", () => ({
  config: {
    RETELL_SIGNATURE_KEY: "sig-key",
    API_KEY: "internal-api-key",
  },
}));

const {
  mockVerify, mockSendSms, mockSendSmsToAll, mockSendEmail, mockGetEmailStatus,
  mockSendOwnerCallMonitor, mockTriggerDispatchCall, mockSaveCallLog, mockCheckAgentAlerts,
  mockRunTranscriptReview,
  mockAgentIdToClient, mockAgentIdToSlug,
} = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockSendSms: vi.fn(),
  mockSendSmsToAll: vi.fn(),
  mockSendEmail: vi.fn(),
  mockGetEmailStatus: vi.fn(),
  mockSendOwnerCallMonitor: vi.fn(),
  mockTriggerDispatchCall: vi.fn(),
  mockSaveCallLog: vi.fn(),
  mockCheckAgentAlerts: vi.fn(),
  mockRunTranscriptReview: vi.fn(),
  mockAgentIdToClient: {} as Record<string, any>,
  mockAgentIdToSlug: {} as Record<string, string>,
}));

vi.mock("../../../lib/verify-retell.js", () => ({
  verifyRetellWebhookOr401: (...a: unknown[]) => mockVerify(...a),
}));
vi.mock("../../../lib/notify-sms.js", () => ({
  sendSms: (...a: unknown[]) => mockSendSms(...a),
  sendSmsToAll: (...a: unknown[]) => mockSendSmsToAll(...a),
}));
vi.mock("../../../lib/notify-email.js", () => ({
  sendEmail: (...a: unknown[]) => mockSendEmail(...a),
  getEmailStatus: (...a: unknown[]) => mockGetEmailStatus(...a),
}));
vi.mock("../../../lib/owner-monitor.js", () => ({
  sendOwnerCallMonitor: (...a: unknown[]) => mockSendOwnerCallMonitor(...a),
}));
vi.mock("../../../lib/dispatch-call.js", () => ({
  triggerDispatchCall: (...a: unknown[]) => mockTriggerDispatchCall(...a),
}));
vi.mock("../../../lib/call-log.js", () => ({
  saveCallLog: (...a: unknown[]) => mockSaveCallLog(...a),
}));
vi.mock("../../../lib/agent-alerts.js", () => ({
  checkAgentAlerts: (...a: unknown[]) => mockCheckAgentAlerts(...a),
}));
vi.mock("../../../lib/transcript-review.js", () => ({
  runTranscriptReview: (...a: unknown[]) => mockRunTranscriptReview(...a),
}));
vi.mock("../../../_cache/clients.js", () => ({
  agentIdToClient: mockAgentIdToClient,
  agentIdToSlug: mockAgentIdToSlug,
}));

const { postHookHandler } = await import("../post-hook.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReq(body: any, headers: Record<string, string> = {}): Request {
  return {
    headers: { "x-retell-signature": "sig", ...headers },
    rawBody: JSON.stringify(body),
    body,
  } as any;
}

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    name: "Acme",
    agent_id: "agent_1",
    dispatch_text_numbers: ["+15550001111"],
    dispatch_email: ["acme@x.com"],
    dispatch_cc: null,
    dispatch_call_number: null,
    summary_agent_id: null,
    shadow_mode: false,
    resolve_type: () => "default",
    message_types: {
      default: {
        label: "New Lead",
        subject_template: "New lead from {{full_name}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
        ],
      },
    },
    default_message_type: "default",
    ...overrides,
  };
}

function makeBody(overrides: { event?: string; call?: Record<string, unknown> } = {}) {
  const { call: callOverride, ...rest } = overrides;
  return {
    event: "call_ended",
    call: {
      call_id: "call_x1",
      agent_id: "agent_1",
      from_number: "+15559990000",
      to_number: "+15550001111",
      duration_ms: 30_000,
      disconnection_reason: "user_hangup",
      collected_dynamic_variables: {
        full_name: "John Smith",
        phone_number: "+15559990000",
      },
      retell_llm_dynamic_variables: {},
      transcript: "User: hello.\nAgent: hi there.",
      ...callOverride,
    },
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockReturnValue(true);
  mockCheckAgentAlerts.mockReturnValue({
    callSurge: { fired: false, count: 0 },
    costSurge: { fired: false, totalCents: 0 },
  });
  mockSendSms.mockResolvedValue({ sid: "SM_1" });
  mockSendSmsToAll.mockResolvedValue([]);
  mockSendEmail.mockResolvedValue({ id: "rs_1" });
  mockSendOwnerCallMonitor.mockResolvedValue(undefined);
  mockTriggerDispatchCall.mockResolvedValue(undefined);
  mockSaveCallLog.mockResolvedValue(undefined);
  mockRunTranscriptReview.mockResolvedValue(undefined);

  for (const k of Object.keys(mockAgentIdToClient)) delete mockAgentIdToClient[k];
  for (const k of Object.keys(mockAgentIdToSlug)) delete mockAgentIdToSlug[k];

  mockAgentIdToClient["agent_1"] = makeClient();
  mockAgentIdToSlug["agent_1"] = "acme";
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("postHookHandler → runTranscriptReview wiring", () => {
  it("invokes runTranscriptReview after a normal dispatched call", async () => {
    const res = makeRes();
    await postHookHandler(makeReq(makeBody()), res);

    expect(mockRunTranscriptReview).toHaveBeenCalledOnce();
    const args = mockRunTranscriptReview.mock.calls[0][0];
    expect(args.callId).toBe("call_x1");
    expect(args.agentId).toBe("agent_1");
    expect(args.isShadowOrTest).toBe(false);
    // The full call payload should be threaded through unchanged so the
    // analyzer can read transcript_object / dynamic vars / disconnection.
    expect(args.call.transcript).toBe("User: hello.\nAgent: hi there.");
    expect(args.call.collected_dynamic_variables).toEqual({
      full_name: "John Smith",
      phone_number: "+15559990000",
    });
  });

  it("flags isShadowOrTest=true for shadow_mode clients (so the analyzer skips)", async () => {
    mockAgentIdToClient["agent_1"] = makeClient({ shadow_mode: true });
    const res = makeRes();
    // Shadow mode short-circuits before transcript-review fires (handler
    // returns early after the dry-run preview); assert that.
    await postHookHandler(makeReq(makeBody()), res);
    expect(mockRunTranscriptReview).not.toHaveBeenCalled();
  });

  it("flags isShadowOrTest=true under x-test-mode (test-mode branch returns before review fires)", async () => {
    const res = makeRes();
    await postHookHandler(
      makeReq(makeBody(), { "x-api-key": "internal-api-key", "x-test-mode": "true" }),
      res,
    );
    // The test-mode branch saves a call log and returns 200 before the
    // dispatch path. runTranscriptReview is only called on the dispatched
    // path today — locking that in.
    expect(mockRunTranscriptReview).not.toHaveBeenCalled();
    expect(res._status).toBe(200);
  });

  it("does NOT fire transcript-review for web calls (no real phone number)", async () => {
    const res = makeRes();
    await postHookHandler(
      makeReq(makeBody({ call: { from_number: null, agent_id: "agent_1" } })),
      res,
    );
    expect(mockRunTranscriptReview).not.toHaveBeenCalled();
  });

  it("does not crash the post-hook response when runTranscriptReview throws (fire-and-forget)", async () => {
    // The handler attaches .catch on the promise, but we still need to
    // simulate a rejection happening AFTER res.json() has been sent.
    mockRunTranscriptReview.mockImplementation(() => Promise.reject(new Error("analyzer crashed")));
    const res = makeRes();
    await postHookHandler(makeReq(makeBody()), res);
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    // Give the microtask queue a tick to clear the unhandled rejection
    // (the handler's .catch handles it).
    await new Promise((r) => setImmediate(r));
  });
});
