// Integration tests verifying that operators (and other under-privileged
// users) cannot reach destructive / sensitive routes. The point isn't to
// exercise the handlers — those have their own tests — but to lock the
// permission gates in place so a future refactor can't silently demote
// `requirePermission("delete_agents")` to a no-op.
//
// Strategy: mount the real `dashboardApiRouter`, walk the middleware
// stack manually with a forged `req.user`, and assert the route either
// fires the handler (200/4xx/5xx — anything that isn't 403) or refuses
// with 403 before it even reaches the handler. Handlers themselves are
// stubbed out via `vi.mock` so the test never touches Mongo/Retell.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── Mocks: stub out everything the routes pull in. ────────────────────────

vi.mock("../../../config.js", () => ({ config: { RETELL_API_KEY: "k", API_KEY: "internal" } }));
vi.mock("retell-sdk", () => ({ default: class { agent = { retrieve: vi.fn(), update: vi.fn(), delete: vi.fn() }; conversationFlow = { delete: vi.fn() }; phoneNumber = { list: vi.fn().mockResolvedValue([]), update: vi.fn() }; } }));

vi.mock("../../../config/client-store.js", () => ({
  getClientDocument: vi.fn().mockResolvedValue({ name: "Acme", agent_id: "agent_1" }),
  updateClientField: vi.fn(),
  updateClientFields: vi.fn(),
  softDeleteClient: vi.fn(),
  restoreClient: vi.fn(),
  deleteClient: vi.fn(),
  listDeletedClients: vi.fn().mockResolvedValue([]),
  loadClientsFromDb: vi.fn(),
  ConcurrencyError: class extends Error { code = "CONCURRENCY_CONFLICT"; },
}));
vi.mock("../../../_cache/clients.js", () => ({ notificationClients: {} }));

vi.mock("../../../lib/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../../lib/root-alerts.js", () => ({ alertRootIfNeeded: vi.fn() }));
vi.mock("../../../lib/settings.js", () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../../lib/blast-sms.js", () => ({
  previewBlast: vi.fn().mockReturnValue({ total_recipients: 0, total_clients: 0, sample_message: "" }),
  sendBlast: vi.fn().mockResolvedValue({ total_recipients: 0, total_clients: 0, sent: 0, failed: [] }),
}));
vi.mock("../../../lib/users.js", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/users.js")>("../../../lib/users.js");
  return {
    ...actual,
    listUsers: vi.fn().mockResolvedValue([]),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    updateUserPermissions: vi.fn(),
  };
});
vi.mock("../../../lib/release-agent-resources.js", () => ({
  releaseAgentResources: vi.fn().mockResolvedValue({ released_numbers: [], errors: [] }),
}));
vi.mock("../../../lib/data-point-defaults.js", () => ({
  getDataPointDefaultsWithCategory: vi.fn().mockResolvedValue([]),
  updateDataPointDefault: vi.fn(),
  createDataPointDefault: vi.fn(),
  deleteDataPointDefault: vi.fn(),
  reorderDataPointDefaults: vi.fn(),
}));
vi.mock("../../../lib/db.js", () => ({
  getDb: () => ({
    collection: () => ({
      find: () => ({ sort: () => ({ toArray: () => [], next: () => null }) }),
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
      deleteOne: vi.fn(),
      updateOne: vi.fn(),
      updateMany: vi.fn(),
      command: vi.fn(),
    }),
  }),
}));
vi.mock("../../../lib/cogs.js", () => ({
  getClientCogs: vi.fn().mockResolvedValue({}),
  getMtdCogsForAllClients: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../../lib/billing-cogs.js", () => ({
  getClientCogs: vi.fn().mockResolvedValue({}),
  getMtdCogsForAllClients: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../../lib/agent-versions.js", () => ({}));
vi.mock("../../../lib/portal-token.js", () => ({ generatePortalToken: vi.fn().mockReturnValue("tok") }));
vi.mock("../../../lib/call-log.js", () => ({
  getCallLogsByClient: vi.fn().mockResolvedValue([]),
  getCallLogById: vi.fn(),
}));
vi.mock("../../../lib/sms-to-all.js", () => ({ sendSmsToAll: vi.fn() }));
vi.mock("../../../lib/retell-display-sync.js", () => ({ syncRetellDisplayLabels: vi.fn().mockResolvedValue({ agentNameUpdated: true, nicknameUpdated: [], nicknameErrors: [], friendlyNameUpdated: [], friendlyNameErrors: [] }) }));
vi.mock("../node-editor.js", async () => ({ nodeEditorRouter: (await import("express")).Router() }));
vi.mock("../delete-agent.js", () => ({ deleteAgentHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })) }));
vi.mock("../get-agent.js", () => ({ getAgentHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })) }));
vi.mock("../get-calls.js", () => ({ getCallsHandler: vi.fn((_req: Request, res: Response) => res.json([])) }));
vi.mock("../list-agents.js", () => ({ listAgentsHandler: vi.fn((_req: Request, res: Response) => res.json([])) }));
vi.mock("../list-phone-numbers.js", () => ({ listPhoneNumbersHandler: vi.fn((_req: Request, res: Response) => res.json([])) }));
vi.mock("../update-agent.js", () => ({ updateAgentHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })) }));
vi.mock("../clone-agent.js", () => ({ cloneAgentHandler: vi.fn((_req: Request, res: Response) => res.status(201).json({ ok: true })) }));
vi.mock("../toggle-active.js", () => ({ toggleActiveHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })) }));
vi.mock("../toggle-shadow.js", () => ({ toggleShadowHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })) }));
vi.mock("../move-agent-folder.js", () => ({ moveAgentFolderHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })) }));
vi.mock("../folders.js", () => ({
  listFoldersHandler: vi.fn((_req: Request, res: Response) => res.json([])),
  createFolderHandler: vi.fn((_req: Request, res: Response) => res.status(201).json({ ok: true })),
  updateFolderHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })),
  deleteFolderHandler: vi.fn((_req: Request, res: Response) => res.json({ ok: true })),
}));
vi.mock("../../agents/export-agent.js", () => ({ exportAgentHandler: vi.fn((_req: Request, res: Response) => res.json({})) }));

const { dashboardApiRouter } = await import("../index.js");

// ── Test harness ──────────────────────────────────────────────────────────

interface UserShape {
  username: string;
  role: "viewer" | "operator" | "admin" | "super_admin";
  permissions: Record<string, boolean>;
  isRoot: boolean;
}

function makeUser(role: UserShape["role"], overrides: Partial<UserShape["permissions"]> = {}): UserShape {
  // Mirror the operator default in src/lib/users.ts: most things on,
  // destructive things off. Tests then flip the specific perm under test.
  const operatorBase = {
    create_agents: true,
    edit_agents: true,
    clone_agents: true,
    delete_agents: false,
    send_comms: true,
    manage_settings: false,
    manage_data_points: false,
    manage_users: false,
    manage_deleted: false,
  };
  const adminBase = Object.fromEntries(Object.keys(operatorBase).map((k) => [k, true]));
  const viewerBase = Object.fromEntries(Object.keys(operatorBase).map((k) => [k, false]));
  const base = role === "viewer" ? viewerBase : role === "operator" ? operatorBase : adminBase;
  return {
    username: `${role}-test`,
    role,
    permissions: { ...base, ...overrides } as Record<string, boolean>,
    isRoot: false,
  };
}

function makeRes() {
  const res: any = { _status: 200, _json: null, _ended: false };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; res._ended = true; return res; };
  return res;
}

function makeReq(user: UserShape, opts: { params?: Record<string, string>; body?: unknown } = {}) {
  return { user, params: opts.params ?? {}, body: opts.body ?? {}, query: {}, headers: {}, get: () => undefined } as unknown as Request;
}

function findRoute(router: any, method: string, path: string) {
  for (const layer of router.stack as any[]) {
    if (!layer.route) continue;
    if (layer.route.path === path && layer.route.methods[method]) return layer.route.stack;
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

async function runRoute(router: any, method: string, path: string, req: Request, res: Response) {
  const stack = findRoute(router, method, path);
  for (let i = 0; i < stack.length; i++) {
    let advance = false;
    let nextErr: unknown = null;
    const next = (err?: unknown) => { if (err) nextErr = err; advance = true; };
    const result = stack[i].handle(req, res, next);
    if (result && typeof (result as Promise<unknown>).then === "function") await result;
    if (nextErr) throw nextErr;
    if (!advance) return;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Permission matrix ─────────────────────────────────────────────────────
//
// For each [method, path, perm] tuple, verify:
//   - operator with perm=false → 403
//   - operator with perm=true  → handler runs (NOT 403)

interface GateCase {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  perm: string;
  // Body needed to get past the handler's input validation; it's fine to
  // omit (the test only cares that the response isn't 403).
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}

const CASES: GateCase[] = [
  { method: "patch",  path: "/agents/:slug",                       perm: "edit_agents",      params: { slug: "acme" }, body: { display_name: "X" } },
  { method: "patch",  path: "/agents/:slug/shadow",                perm: "edit_agents",      params: { slug: "acme" }, body: { shadow_mode: true } },
  { method: "patch",  path: "/agents/:slug/active",                perm: "edit_agents",      params: { slug: "acme" }, body: { active: true } },
  { method: "patch",  path: "/agents/:slug/folder",                perm: "edit_agents",      params: { slug: "acme" }, body: { folder_id: null } },
  { method: "post",   path: "/agents/:slug/clone",                 perm: "clone_agents",     params: { slug: "acme" }, body: { name: "X", faq: "Y" } },
  { method: "delete", path: "/agents/:slug",                       perm: "delete_agents",    params: { slug: "acme" } },
  { method: "post",   path: "/folders",                            perm: "edit_agents",      body: { name: "F" } },
  { method: "patch",  path: "/folders/:id",                        perm: "edit_agents",      params: { id: "x" } },
  { method: "delete", path: "/folders/:id",                        perm: "edit_agents",      params: { id: "x" } },
  { method: "get",    path: "/deleted-agents",                     perm: "manage_deleted" },
  { method: "post",   path: "/deleted-agents/:slug/restore",       perm: "manage_deleted",   params: { slug: "acme" } },
  { method: "delete", path: "/deleted-agents/:slug",               perm: "manage_deleted",   params: { slug: "acme" } },
  { method: "patch",  path: "/settings",                           perm: "manage_settings",  body: {} },
  { method: "post",   path: "/blast-sms/preview",                  perm: "send_comms",       body: { message: "hi" } },
  { method: "post",   path: "/blast-sms",                          perm: "send_comms",       body: { message: "hi", confirm: true, confirm_recipients: 0 } },
];

describe("dashboard route permission gates", () => {
  for (const c of CASES) {
    it(`${c.method.toUpperCase()} ${c.path} requires "${c.perm}"`, async () => {
      // Without the perm: must 403.
      const denied = makeRes();
      await runRoute(
        dashboardApiRouter,
        c.method,
        c.path,
        makeReq(makeUser("operator", { [c.perm]: false }), { params: c.params, body: c.body }),
        denied,
      );
      expect(denied._status, `${c.method} ${c.path} should 403 without ${c.perm}`).toBe(403);

      // With the perm: must NOT 403 (the handler is mocked to 200/201/etc).
      const allowed = makeRes();
      await runRoute(
        dashboardApiRouter,
        c.method,
        c.path,
        makeReq(makeUser("operator", { [c.perm]: true }), { params: c.params, body: c.body }),
        allowed,
      );
      expect(allowed._status, `${c.method} ${c.path} should pass when ${c.perm} is granted`).not.toBe(403);
    });
  }

  it("blast-sms (send) is gated on send_comms, NOT manage_settings", async () => {
    // A "settings admin" who lacks send_comms must NOT be able to blast.
    const res = makeRes();
    await runRoute(
      dashboardApiRouter,
      "post",
      "/blast-sms",
      makeReq(
        makeUser("operator", { manage_settings: true, send_comms: false }),
        { body: { message: "hi", confirm: true, confirm_recipients: 0 } },
      ),
      res,
    );
    expect(res._status).toBe(403);
  });
});
