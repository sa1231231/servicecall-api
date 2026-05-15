import { describe, it, expect, vi, beforeEach } from "vitest";

// send-sms-service is the shared mid-call SMS pipeline behind both the
// Retell CustomTool endpoint and the MCP send_sms handler. It was only
// covered indirectly via those wrappers — this exercises the validation
// branches + outbound-messages logging directly.

vi.mock("../../config.js", () => ({
  config: { TWILIO_PHONE_NUMBER: "+15550000000" },
}));

const {
  mockSendSmsFrom,
  mockSaveOutboundMessage,
  mockAgentIdToClient,
  mockAgentIdToSlug,
} = vi.hoisted(() => ({
  mockSendSmsFrom: vi.fn(),
  mockSaveOutboundMessage: vi.fn(),
  mockAgentIdToClient: {} as Record<string, any>,
  mockAgentIdToSlug: {} as Record<string, string>,
}));

vi.mock("../notify-sms.js", () => ({
  sendSmsFrom: (...a: any[]) => mockSendSmsFrom(...a),
}));
vi.mock("../outbound-messages.js", () => ({
  saveOutboundMessage: (...a: any[]) => mockSaveOutboundMessage(...a),
}));
vi.mock("../../_cache/clients.js", () => ({
  agentIdToClient: mockAgentIdToClient,
  agentIdToSlug: mockAgentIdToSlug,
}));

const { sendSmsForCall } = await import("../send-sms-service.js");

const AGENT = "agent_x";

beforeEach(() => {
  mockSendSmsFrom.mockReset();
  mockSaveOutboundMessage.mockReset();
  for (const k of Object.keys(mockAgentIdToClient)) delete mockAgentIdToClient[k];
  for (const k of Object.keys(mockAgentIdToSlug)) delete mockAgentIdToSlug[k];
  // Default: a configured client + a successful Twilio send.
  mockAgentIdToClient[AGENT] = { name: "Acme HVAC", outbound_from_number: "+15551112222" };
  mockAgentIdToSlug[AGENT] = "acme-hvac";
  mockSendSmsFrom.mockResolvedValue({ sid: "SM_test", status: "queued" });
  mockSaveOutboundMessage.mockResolvedValue(undefined);
});

function baseArgs(overrides: Partial<Parameters<typeof sendSmsForCall>[0]> = {}) {
  return {
    agentId: AGENT,
    callId: "call_1",
    fromNumber: "+13015551234",
    message: "Your technician is on the way.",
    source: "mcp" as const,
    ...overrides,
  };
}

describe("sendSmsForCall — validation branches", () => {
  it("404 when the agent has no client config", async () => {
    const r = await sendSmsForCall(baseArgs({ agentId: "agent_unknown" }));
    expect(r).toEqual({ ok: false, status: 404, error: expect.stringMatching(/No client configured/) });
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
    expect(mockSaveOutboundMessage).not.toHaveBeenCalled();
  });

  it("404 when agentId is null", async () => {
    const r = await sendSmsForCall(baseArgs({ agentId: null }));
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(404);
  });

  it("400 on empty / whitespace-only message", async () => {
    expect((await sendSmsForCall(baseArgs({ message: "" }))).status).toBe(400);
    expect((await sendSmsForCall(baseArgs({ message: "   " }))).status).toBe(400);
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
  });

  it("400 when message exceeds the 1600-char cap", async () => {
    const r = await sendSmsForCall(baseArgs({ message: "x".repeat(1601) }));
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(400);
    expect((r as any).error).toMatch(/too long/i);
  });

  it("400 when no recipient (no `to`, unusable fromNumber)", async () => {
    for (const fromNumber of ["", "Web Call", "unknown"]) {
      const r = await sendSmsForCall(baseArgs({ fromNumber, to: undefined }));
      expect(r.ok, `fromNumber="${fromNumber}"`).toBe(false);
      expect((r as any).status).toBe(400);
    }
  });

  it("400 when the recipient is not E.164", async () => {
    const r = await sendSmsForCall(baseArgs({ to: "555-1234", fromNumber: "" }));
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(400);
    expect((r as any).error).toMatch(/E\.164/);
  });
});

describe("sendSmsForCall — send + logging", () => {
  it("happy path: sends via Twilio, logs outbound, returns 200", async () => {
    const r = await sendSmsForCall(baseArgs());
    expect(r).toEqual({ ok: true, status: 200, result: expect.stringContaining("+13015551234") });
    // Sent from the client's outbound_from_number, to the caller.
    expect(mockSendSmsFrom).toHaveBeenCalledWith(
      "+15551112222", "+13015551234", "Your technician is on the way.",
    );
    expect(mockSaveOutboundMessage).toHaveBeenCalledTimes(1);
    const logged = mockSaveOutboundMessage.mock.calls[0][0];
    expect(logged).toMatchObject({
      call_id: "call_1",
      client_slug: "acme-hvac",
      client_name: "Acme HVAC",
      agent_id: AGENT,
      to: "+13015551234",
      from: "+15551112222",
      twilio_sid: "SM_test",
      twilio_status: "queued",
      source: "mcp",
      error: null,
    });
  });

  it("explicit `to` overrides the caller's fromNumber", async () => {
    await sendSmsForCall(baseArgs({ to: "+19998887777" }));
    expect(mockSendSmsFrom).toHaveBeenCalledWith(
      "+15551112222", "+19998887777", expect.any(String),
    );
  });

  it("falls back to TWILIO_PHONE_NUMBER when the client has no outbound number", async () => {
    mockAgentIdToClient[AGENT] = { name: "Acme HVAC" }; // no outbound_from_number
    await sendSmsForCall(baseArgs());
    expect(mockSendSmsFrom).toHaveBeenCalledWith(
      "+15550000000", "+13015551234", expect.any(String),
    );
  });

  it("trims the message before sending", async () => {
    await sendSmsForCall(baseArgs({ message: "  hello  " }));
    expect(mockSendSmsFrom).toHaveBeenCalledWith(expect.any(String), expect.any(String), "hello");
  });

  it("502 when Twilio send fails — but still logs the attempt with the error", async () => {
    mockSendSmsFrom.mockRejectedValue(new Error("Twilio 21610: unsubscribed recipient"));
    const r = await sendSmsForCall(baseArgs());
    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(502);
    expect((r as any).error).toMatch(/Failed to send SMS/);
    // The failed send is still recorded in outbound_messages with the error.
    expect(mockSaveOutboundMessage).toHaveBeenCalledTimes(1);
    const logged = mockSaveOutboundMessage.mock.calls[0][0];
    expect(logged.twilio_sid).toBeNull();
    expect(logged.error).toMatch(/unsubscribed recipient/);
  });
});
