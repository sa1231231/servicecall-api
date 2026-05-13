import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../config.js", () => ({
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

vi.mock("../../lib/notify-sms.js", () => ({
  sendSmsFrom: (...a: any[]) => mockSendSmsFrom(...a),
}));

vi.mock("../../lib/outbound-messages.js", () => ({
  saveOutboundMessage: (...a: any[]) => mockSaveOutboundMessage(...a),
}));

vi.mock("../../_cache/clients.js", () => ({
  agentIdToClient: mockAgentIdToClient,
  agentIdToSlug: mockAgentIdToSlug,
}));

const { mcpPostHandler } = await import("../mcp.js");

function makeReq(body: any, headers: Record<string, string> = {}): Request {
  return {
    headers: { authorization: "Bearer internal-api-key", ...headers },
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
  res.end = () => res;
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockAgentIdToClient)) delete mockAgentIdToClient[k];
  for (const k of Object.keys(mockAgentIdToSlug)) delete mockAgentIdToSlug[k];
  mockSendSmsFrom.mockResolvedValue({ sid: "SMxxx", status: "queued" });
});

describe("MCP server — auth", () => {
  it("rejects requests with no Authorization header", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "" });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(401);
    expect(res._json.error.message).toMatch(/Unauthorized/);
  });

  it("rejects requests with wrong bearer token", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer wrong-key" });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(401);
  });

  it("accepts x-api-key as a fallback", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      authorization: "",
      "x-api-key": "internal-api-key",
    });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
  });
});

describe("MCP server — method dispatch", () => {
  it("initialize returns protocol info + tool capability", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.jsonrpc).toBe("2.0");
    expect(res._json.id).toBe(1);
    expect(res._json.result.serverInfo.name).toBe("servicecall-mcp");
    expect(res._json.result.capabilities.tools).toBeDefined();
  });

  it("tools/list returns the send_sms catalog", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.result.tools).toHaveLength(1);
    expect(res._json.result.tools[0].name).toBe("send_sms");
    expect(res._json.result.tools[0].inputSchema.required).toEqual(["message"]);
  });

  it("notifications/initialized returns 204 with no body", async () => {
    const req = makeReq({ jsonrpc: "2.0", method: "notifications/initialized" });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(204);
  });

  it("unknown method returns JSON-RPC method-not-found", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 9, method: "bogus/method" });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.error.code).toBe(-32601);
  });

  it("non-JSON-RPC body rejected with 400", async () => {
    const req = makeReq({ method: "tools/list" }); // missing jsonrpc
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(400);
  });

  it("batched requests rejected", async () => {
    const req = makeReq([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(400);
    expect(res._json.error.message).toMatch(/Batched/);
  });
});

describe("MCP server — tools/call send_sms", () => {
  it("dispatches send_sms with caller context from request body", async () => {
    mockAgentIdToClient["agent_x"] = { name: "Acme", outbound_from_number: "+15550001111" };
    mockAgentIdToSlug["agent_x"] = "acme";

    const req = makeReq({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "send_sms",
        arguments: { message: "Hi from MCP!" },
      },
      // call context carried alongside params (matches Retell's existing
      // CustomTool body shape — keeping it for parity).
      call: { agent_id: "agent_x", call_id: "call_42", from_number: "+18005551234" },
    });
    const res = makeRes();
    await mcpPostHandler(req, res);

    expect(res._status).toBe(200);
    expect(res._json.result.content[0].text).toMatch(/Text message sent to \+18005551234/);
    expect(mockSendSmsFrom).toHaveBeenCalledWith("+15550001111", "+18005551234", "Hi from MCP!");
    expect(mockSaveOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "mcp",
        agent_id: "agent_x",
        call_id: "call_42",
        to: "+18005551234",
        body: "Hi from MCP!",
      }),
    );
  });

  it("returns isError on bad recipient", async () => {
    mockAgentIdToClient["agent_x"] = { name: "Acme", outbound_from_number: "+15550001111" };
    const req = makeReq({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "send_sms", arguments: { message: "Hi", to: "not-a-phone" } },
      call: { agent_id: "agent_x", call_id: "c", from_number: "" },
    });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.result.isError).toBe(true);
    expect(res._json.result.content[0].text).toMatch(/E\.164/);
  });

  it("unknown tool name returns JSON-RPC method-not-found", async () => {
    const req = makeReq({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "delete_everything", arguments: {} },
    });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(res._json.error.code).toBe(-32601);
    expect(res._json.error.message).toMatch(/Unknown tool/);
  });
});
