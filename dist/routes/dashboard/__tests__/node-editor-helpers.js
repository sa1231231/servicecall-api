export function makeRes() {
    const res = { _status: 200, _json: null };
    res.status = (code) => {
        res._status = code;
        return res;
    };
    res.json = (data) => {
        res._json = data;
        return res;
    };
    return res;
}
export function makeReq(opts) {
    return {
        params: opts.params ?? {},
        body: opts.body ?? {},
        query: opts.query ?? {},
        user: opts.username ? { username: opts.username } : undefined,
    };
}
export function makeDoc(overrides = {}) {
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
export function findRoute(router, method, path) {
    const layers = router.stack;
    for (const layer of layers) {
        if (!layer.route)
            continue;
        const r = layer.route;
        if (r.path === path && r.methods[method]) {
            return r.stack;
        }
    }
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}
// Express-like middleware runner that properly awaits async handlers
// across a multi-middleware route stack.
export async function runRoute(router, method, path, req, res) {
    const stack = findRoute(router, method, path);
    for (let i = 0; i < stack.length; i++) {
        let advance = false;
        let nextErr = null;
        const next = (err) => {
            if (err)
                nextErr = err;
            advance = true;
        };
        const result = stack[i].handle(req, res, next);
        if (result && typeof result.then === "function") {
            await result;
        }
        if (nextErr)
            throw nextErr;
        if (!advance)
            return;
    }
}
