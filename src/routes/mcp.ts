import { Router } from "express";
import express from "express";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { sendSmsForCall } from "../lib/send-sms-service.js";

// MCP (Model Context Protocol) server for this app's tool ecosystem. Speaks
// JSON-RPC 2.0 over HTTP. Currently exposes a single tool — send_sms — for
// mid-call SMS sends from Retell-driven conversation flows. Add new tools by
// registering them in the TOOLS map below.
//
// Auth: bearer token matching config.API_KEY. Retell forwards whatever headers
// are configured on the per-flow Mcp entry (flow.mcps[]); we register the
// servicecall-mcp entry with Authorization: Bearer <API_KEY>.

export const mcpRouter = Router();

mcpRouter.use(express.json({ limit: "10mb" }));

// ── JSON-RPC types ─────────────────────────────────────────────────────────

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

// ── Tool registry ──────────────────────────────────────────────────────────

interface ToolContext {
  /** Retell call context, when available. Populated from request body if the
   *  client (Retell) forwards it on tools/call. May be null for ad-hoc clients. */
  agentId: string | null;
  callId: string | null;
  fromNumber: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolCallResult>;
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const TOOLS: Record<string, ToolDefinition> = {
  send_sms: {
    name: "send_sms",
    description:
      "Send an SMS to the caller mid-call. Defaults to the caller's phone number when 'to' is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "SMS body, max 1600 chars." },
        to: { type: "string", description: "Recipient phone in E.164 format. Omit to send to the caller." },
      },
      required: ["message"],
    },
    async handler(args, ctx) {
      const result = await sendSmsForCall({
        agentId: ctx.agentId,
        callId: ctx.callId,
        fromNumber: ctx.fromNumber,
        message: typeof args.message === "string" ? args.message : "",
        to: typeof args.to === "string" ? args.to : undefined,
        source: "mcp",
      });
      if (result.ok) {
        return { content: [{ type: "text", text: result.result }] };
      }
      return { content: [{ type: "text", text: result.error }], isError: true };
    },
  },
};

// ── Auth ───────────────────────────────────────────────────────────────────

function isAuthorized(req: Request): boolean {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token && token === config.API_KEY) return true;
  }
  if (req.headers["x-api-key"] === config.API_KEY) return true;
  return false;
}

// ── Call-context extraction ────────────────────────────────────────────────

/**
 * Pulls Retell's call context off the request. Retell may forward it via:
 *   1. Top-level `call` field in the request body (matches /retell/send-sms shape)
 *   2. Inside `params._meta` (some MCP clients use _meta for transport hints)
 *   3. Inside `params.call` (defensive fallback)
 * If the caller doesn't supply any, the context is empty and the tool handler
 * sees null/empty values — which the SMS service will reject with a clear
 * "no recipient" error unless an explicit `to` was provided.
 */
function extractCallContext(reqBody: any, params: any): ToolContext {
  const call =
    (reqBody && typeof reqBody === "object" && reqBody.call) ||
    (params && typeof params === "object" && (params._meta?.call || params.call)) ||
    null;
  return {
    agentId: typeof call?.agent_id === "string" ? call.agent_id : null,
    callId: typeof call?.call_id === "string" && call.call_id ? call.call_id : null,
    fromNumber: typeof call?.from_number === "string" ? call.from_number : "",
  };
}

// ── JSON-RPC dispatcher ────────────────────────────────────────────────────

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function success(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}
function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

async function dispatch(req: JsonRpcRequest, rawBody: any): Promise<JsonRpcSuccessResponse | JsonRpcErrorResponse | null> {
  const id = req.id ?? null;
  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (req.method) {
    case "initialize": {
      return success(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "servicecall-mcp", version: "1.0.0" },
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled": {
      // Notifications carry no id and expect no response.
      return null;
    }
    case "tools/list": {
      return success(id, {
        tools: Object.values(TOOLS).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS[name];
      if (!tool) {
        return error(id, ERR_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }
      const ctx = extractCallContext(rawBody, params);
      try {
        const result = await tool.handler(args, ctx);
        return success(id, result);
      } catch (err: any) {
        console.error(`mcp: tools/call ${name} threw:`, err);
        return error(id, ERR_INTERNAL, `Tool execution failed: ${err?.message ?? String(err)}`);
      }
    }
    default:
      return error(id, ERR_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

// ── HTTP handler ───────────────────────────────────────────────────────────

export async function mcpPostHandler(req: Request, res: Response) {
  if (!isAuthorized(req)) {
    res.status(401).json(error(null, ERR_INVALID_REQUEST, "Unauthorized. Configure Authorization: Bearer <API_KEY>."));
    return;
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json(error(null, ERR_PARSE, "Invalid JSON body."));
    return;
  }

  // Batched requests are part of JSON-RPC 2.0 but the MCP spec deprecates
  // them. Accept a single request only; reject arrays explicitly so clients
  // see a clear error instead of malformed behavior.
  if (Array.isArray(body)) {
    res.status(400).json(error(null, ERR_INVALID_REQUEST, "Batched requests not supported."));
    return;
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    res.status(400).json(error(body.id ?? null, ERR_INVALID_REQUEST, "Not a JSON-RPC 2.0 request."));
    return;
  }

  const result = await dispatch(body as JsonRpcRequest, body);
  if (result === null) {
    // Notification — return 204 with no body.
    res.status(204).end();
    return;
  }
  res.status(200).json(result);
}

mcpRouter.post("/", mcpPostHandler);

// Health check / discovery convenience for humans pointing browsers at /mcp.
mcpRouter.get("/", (_req, res) => {
  res.json({
    server: "servicecall-mcp",
    protocol: "json-rpc-2.0",
    transport: "http",
    tools: Object.keys(TOOLS),
    note: "POST JSON-RPC 2.0 requests here. Auth via Authorization: Bearer <API_KEY>.",
  });
});
