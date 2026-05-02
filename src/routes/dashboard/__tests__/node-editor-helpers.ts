import type { Request, Response } from "express";

export type MockRes = Response & { _status: number; _json: any };

export function makeRes(): MockRes {
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

export function makeReq(opts: {
  params?: Record<string, string>;
  body?: any;
  query?: Record<string, any>;
  username?: string;
}): Request {
  return {
    params: opts.params ?? {},
    body: opts.body ?? {},
    query: opts.query ?? {},
    user: opts.username ? { username: opts.username } : undefined,
  } as any;
}

export function makeDoc(overrides: Record<string, any> = {}) {
  return {
    _id: "acme",
    name: "Acme",
    agent_id: "agent_1",
    retell_agents: { agent_1: { conversationFlow: { nodes: [] } } },
    dispatch_text_numbers: [],
    dispatch_email: [],
    message_types: {},
    ...overrides,
  };
}

export function findRoute(router: any, method: string, path: string) {
  const layers = router.stack as any[];
  for (const layer of layers) {
    if (!layer.route) continue;
    const r = layer.route;
    if (r.path === path && r.methods[method]) {
      return r.stack;
    }
  }
  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

// Express-like middleware runner that properly awaits async handlers
// across a multi-middleware route stack.
export async function runRoute(
  router: any,
  method: string,
  path: string,
  req: Request,
  res: Response,
) {
  const stack = findRoute(router, method, path);
  for (let i = 0; i < stack.length; i++) {
    let advance = false;
    let nextErr: any = null;
    const next = (err?: any) => {
      if (err) nextErr = err;
      advance = true;
    };
    const result = stack[i].handle(req, res, next);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
    if (nextErr) throw nextErr;
    if (!advance) return;
  }
}
