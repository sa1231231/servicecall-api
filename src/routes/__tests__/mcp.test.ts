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

const { mcpPostHandler, mcpDiscoveryHandler, mcpBodyErrorHandler } = await import("../mcp.js");

function makeReq(body: any, headers: Record<string, string> = {}): Request {
  return {
    headers: { authorization: "Bearer internal-api-key", ...headers },
    body,
  } as any;
}

function makeRes(): Response & {
  _status: number;
  _json: any;
  _headers: Record<string, string>;
  _sse: string;
} {
  const res: any = { _status: 200, _json: null, _headers: {}, _sse: "" };
  res.status = (code: number) => {
    res._status = code;
    return res;
  };
  res.json = (data: any) => {
    res._json = data;
    return res;
  };
  res.setHeader = (key: string, value: string) => {
    res._headers[key.toLowerCase()] = value;
    return res;
  };
  res.write = (chunk: string) => {
    res._sse += chunk;
    return true;
  };
  res.end = () => res;
  return res;
}

// Pull the JSON-RPC payload out of a one-shot SSE response body.
function parseSse(raw: string): any {
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error("no SSE data line in: " + JSON.stringify(raw));
  return JSON.parse(line.slice("data:".length).trim());
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

describe("MCP server — Streamable HTTP / SSE", () => {
  // Retell's MCP client speaks Streamable HTTP: it sends
  // `Accept: ...text/event-stream` and requires the JSON-RPC response framed
  // as an SSE `message` event. A plain application/json body fails it with
  // "error parsing json response from mcp server". These pin that framing.
  const sseHeaders = { accept: "application/json, text/event-stream" };

  it("frames the response as an SSE message event when the client accepts SSE", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, sseHeaders);
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(res._headers["content-type"]).toBe("text/event-stream");
    // The payload rides the SSE stream, not res.json().
    expect(res._json).toBeNull();
    expect(res._sse.startsWith("event: message\ndata: ")).toBe(true);
    expect(res._sse.endsWith("\n\n")).toBe(true);
    const payload = parseSse(res._sse);
    expect(payload.jsonrpc).toBe("2.0");
    expect(payload.result.tools[0].name).toBe("send_sms");
  });

  it("delivers tools/call results over SSE too", async () => {
    mockAgentIdToClient["agent_x"] = { name: "Acme", outbound_from_number: "+15550001111" };
    mockAgentIdToSlug["agent_x"] = "acme";
    const req = makeReq(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "send_sms", arguments: { message: "Hi" } },
        call: { agent_id: "agent_x", call_id: "c", from_number: "+18005551234" },
      },
      sseHeaders,
    );
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._headers["content-type"]).toBe("text/event-stream");
    const payload = parseSse(res._sse);
    expect(payload.id).toBe(7);
    expect(payload.result.content[0].text).toMatch(/Text message sent/);
  });

  it("still returns plain JSON when the client does not accept SSE", async () => {
    const req = makeReq({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { accept: "application/json" });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._headers["content-type"]).toBeUndefined();
    expect(res._sse).toBe("");
    expect(res._json.result.tools[0].name).toBe("send_sms");
  });
});

describe("MCP server — discovery + body-parse errors", () => {
  it("the GET / discovery handler reports the server name + tool list", () => {
    const res = makeRes();
    mcpDiscoveryHandler(makeReq({}), res);
    expect(res._json.server).toBe("servicecall-mcp");
    expect(res._json.tools).toContain("send_sms");
  });

  it("the body-error handler answers a parse failure with a JSON-RPC error, not HTML", () => {
    // express.json() throws on a malformed body; the router error handler
    // must convert that to a clean JSON-RPC error rather than an HTML page.
    const res = makeRes();
    mcpBodyErrorHandler(
      new SyntaxError("Unexpected token < in JSON at position 0"),
      makeReq({}),
      res,
      () => {},
    );
    expect(res._status).toBe(400);
    expect(res._json.error.code).toBe(-32700); // ERR_PARSE
    expect(res._json.error.message).toMatch(/Invalid request body/);
  });
});

describe("MCP server — call-context extraction", () => {
  beforeEach(() => {
    mockAgentIdToClient["agent_x"] = { name: "Acme", outbound_from_number: "+15550001111" };
    mockAgentIdToSlug["agent_x"] = "acme";
  });

  it("reads the call context from params._meta.call", async () => {
    const req = makeReq({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "send_sms",
        arguments: { message: "Hi" },
        _meta: { call: { agent_id: "agent_x", call_id: "c20", from_number: "+18005551234" } },
      },
    });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(mockSendSmsFrom).toHaveBeenCalledWith("+15550001111", "+18005551234", "Hi");
  });

  it("reads the call context from params.call", async () => {
    const req = makeReq({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "send_sms",
        arguments: { message: "Hi" },
        call: { agent_id: "agent_x", call_id: "c21", from_number: "+18005551234" },
      },
    });
    const res = makeRes();
    await mcpPostHandler(req, res);
    expect(res._status).toBe(200);
    expect(mockSendSmsFrom).toHaveBeenCalledWith("+15550001111", "+18005551234", "Hi");
  });
});
