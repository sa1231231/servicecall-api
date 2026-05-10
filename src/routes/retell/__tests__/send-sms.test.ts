import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../../config.js", () => ({
  config: {
    API_KEY: "internal-api-key",
    TWILIO_PHONE_NUMBER: "+15550000000",
  },
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

vi.mock("../../../lib/notify-sms.js", () => ({
  sendSmsFrom: (...a: any[]) => mockSendSmsFrom(...a),
}));

vi.mock("../../../lib/outbound-messages.js", () => ({
  saveOutboundMessage: (...a: any[]) => mockSaveOutboundMessage(...a),
}));

vi.mock("../../../_cache/clients.js", () => ({
  agentIdToClient: mockAgentIdToClient,
  agentIdToSlug: mockAgentIdToSlug,
}));

const { sendSmsHandler } = await import("../send-sms.js");

function makeReq(body: any, headers: Record<string, string> = {}): Request {
  return {
    headers: { "x-api-key": "internal-api-key", ...headers },
    body,
  } as any;
}

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => {
    res._status = code;
    return res;
  };
  res.json = (data: any) => {
    res._json = data;
    return res;
  };
  return res;
}

function makeClient(overrides: Record<string, any> = {}) {
  return {
    name: "Acme",
    agent_id: "agent_1",
    outbound_from_number: "+15551234567",
    dispatch_text_numbers: [],
    dispatch_email: null,
    dispatch_cc: null,
    dispatch_call_number: null,
    summary_agent_id: null,
    resolve_type: () => "default",
    message_types: {},
    default_message_type: "default",
    ...overrides,
  };
}

beforeEach(() => {
  for (const k of Object.keys(mockAgentIdToClient)) delete mockAgentIdToClient[k];
  for (const k of Object.keys(mockAgentIdToSlug)) delete mockAgentIdToSlug[k];
  mockSendSmsFrom.mockReset();
  mockSaveOutboundMessage.mockReset();
  mockSendSmsFrom.mockResolvedValue({ sid: "SM123", status: "queued" });
  mockSaveOutboundMessage.mockResolvedValue(undefined);
});

describe("sendSmsHandler", () => {
  it("returns 401 when no auth header is present", async () => {
    const req = {
      headers: {},
      body: {
        name: "send_sms",
        args: { message: "hi" },
        call: { agent_id: "agent_1", from_number: "+13015551234" },
      },
    } as any;
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(401);
    expect(res._json.error).toMatch(/unauthor/i);
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
    expect(mockSaveOutboundMessage).not.toHaveBeenCalled();
  });

  it("accepts Authorization: Bearer <API_KEY>", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();
    mockAgentIdToSlug["agent_1"] = "acme";

    const req = {
      headers: { authorization: "Bearer internal-api-key" },
      body: {
        name: "send_sms",
        args: { message: "hi" },
        call: { agent_id: "agent_1", from_number: "+13015551234" },
      },
    } as any;
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(200);
    expect(mockSendSmsFrom).toHaveBeenCalled();
  });

  it("rejects wrong Bearer token with 401", async () => {
    const req = {
      headers: { authorization: "Bearer wrong-token" },
      body: {
        name: "send_sms",
        args: { message: "hi" },
        call: { agent_id: "agent_1", from_number: "+13015551234" },
      },
    } as any;
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(401);
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
  });

  it("returns 404 when agent_id has no client config", async () => {
    const req = makeReq({
      name: "send_sms",
      args: { message: "hi" },
      call: { agent_id: "unknown_agent", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(404);
    expect(res._json.success).toBe(false);
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
  });

  it("returns 400 when message is missing or empty", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();
    const req = makeReq({
      name: "send_sms",
      args: { message: "   " },
      call: { agent_id: "agent_1", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/message/i);
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
  });

  it("defaults recipient to call.from_number when 'to' is omitted", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();
    mockAgentIdToSlug["agent_1"] = "acme";

    const req = makeReq({
      name: "send_sms",
      args: { message: "Here is your link: example.com" },
      call: { call_id: "call_x", agent_id: "agent_1", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(mockSendSmsFrom).toHaveBeenCalledWith(
      "+15551234567",
      "+13015551234",
      "Here is your link: example.com",
    );
    expect(mockSaveOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        call_id: "call_x",
        client_slug: "acme",
        agent_id: "agent_1",
        to: "+13015551234",
        from: "+15551234567",
        twilio_sid: "SM123",
        twilio_status: "queued",
        error: null,
        source: "retell_tool",
      }),
    );
  });

  it("uses explicit args.to when provided", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();
    mockAgentIdToSlug["agent_1"] = "acme";

    const req = makeReq({
      name: "send_sms",
      args: { to: "+19998887777", message: "hello supervisor" },
      call: { agent_id: "agent_1", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(200);
    expect(mockSendSmsFrom).toHaveBeenCalledWith(
      "+15551234567",
      "+19998887777",
      "hello supervisor",
    );
  });

  it("falls back to global TWILIO_PHONE_NUMBER when client has no outbound_from_number", async () => {
    mockAgentIdToClient["agent_1"] = makeClient({ outbound_from_number: null });
    mockAgentIdToSlug["agent_1"] = "acme";

    const req = makeReq({
      name: "send_sms",
      args: { message: "hi" },
      call: { agent_id: "agent_1", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(mockSendSmsFrom).toHaveBeenCalledWith(
      "+15550000000",
      "+13015551234",
      "hi",
    );
  });

  it("returns 400 for non-E.164 recipient", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();

    const req = makeReq({
      name: "send_sms",
      args: { to: "555-1234", message: "hi" },
      call: { agent_id: "agent_1", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/E\.164/);
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
  });

  it("returns 400 for web calls with no explicit 'to'", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();

    const req = makeReq({
      name: "send_sms",
      args: { message: "hi" },
      call: { agent_id: "agent_1", from_number: "Web Call" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(400);
    expect(mockSendSmsFrom).not.toHaveBeenCalled();
  });

  it("persists with error and returns 502 when Twilio fails", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();
    mockAgentIdToSlug["agent_1"] = "acme";
    mockSendSmsFrom.mockRejectedValue(new Error("Twilio is down"));

    const req = makeReq({
      name: "send_sms",
      args: { message: "hi" },
      call: { agent_id: "agent_1", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(502);
    expect(res._json.success).toBe(false);
    expect(res._json.error).toMatch(/Twilio is down/);
    expect(mockSaveOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        twilio_sid: null,
        twilio_status: null,
        error: "Twilio is down",
      }),
    );
  });

  it("returns 400 for messages over 1600 chars", async () => {
    mockAgentIdToClient["agent_1"] = makeClient();
    const req = makeReq({
      name: "send_sms",
      args: { message: "x".repeat(1601) },
      call: { agent_id: "agent_1", from_number: "+13015551234" },
    });
    const res = makeRes();
    await sendSmsHandler(req, res);

    expect(res._status).toBe(400);
    expect(res._json.error).toMatch(/too long/i);
  });
});
