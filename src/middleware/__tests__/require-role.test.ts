import { describe, it, expect, vi } from "vitest";
import { requireRole, requirePermission, requireRoot } from "../require-role.js";
import type { Request, Response, NextFunction } from "express";

function mockReq(user?: Request["user"]): Request {
  return { user } as Request;
}

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeUser(overrides: Partial<NonNullable<Request["user"]>> = {}): NonNullable<Request["user"]> {
  return {
    username: "testuser",
    role: "operator",
    permissions: {
      create_agents: true,
      edit_agents: true,
      clone_agents: true,
      delete_agents: false,
      send_comms: true,
      manage_settings: false,
      manage_data_points: false,
      manage_users: false,
    },
    isRoot: false,
    ...overrides,
  };
}

// ── requireRole ─────────────────────────────────────────────────────────────

describe("requireRole", () => {
  it("calls next() when user role is in allowed list", () => {
    const mw = requireRole("admin", "operator");
    const next = vi.fn();
    mw(mockReq(makeUser({ role: "operator" })), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when user role is not in allowed list", () => {
    const mw = requireRole("admin");
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq(makeUser({ role: "viewer" })), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Insufficient permissions" });
  });

  it("returns 401 when no user on request", () => {
    const mw = requireRole("admin");
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ── requirePermission ───────────────────────────────────────────────────────

describe("requirePermission", () => {
  it("calls next() when user has the permission", () => {
    const mw = requirePermission("edit_agents");
    const next = vi.fn();
    mw(mockReq(makeUser()), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when user lacks the permission", () => {
    const mw = requirePermission("delete_agents");
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq(makeUser()), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 401 when no user on request", () => {
    const mw = requirePermission("edit_agents");
    const next = vi.fn();
    const res = mockRes();
    mw(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("allows admin with all permissions", () => {
    const mw = requirePermission("manage_users");
    const next = vi.fn();
    const user = makeUser({
      role: "admin",
      permissions: {
        create_agents: true, edit_agents: true, clone_agents: true,
        delete_agents: true, send_comms: true, manage_settings: true,
        manage_data_points: true, manage_users: true,
      },
    });
    mw(mockReq(user), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks viewer with no permissions", () => {
    const mw = requirePermission("edit_agents");
    const next = vi.fn();
    const res = mockRes();
    const user = makeUser({
      role: "viewer",
      permissions: {
        create_agents: false, edit_agents: false, clone_agents: false,
        delete_agents: false, send_comms: false, manage_settings: false,
        manage_data_points: false, manage_users: false,
      },
    });
    mw(mockReq(user), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ── requireRoot ─────────────────────────────────────────────────────────────

describe("requireRoot", () => {
  it("calls next() when user is root", () => {
    const next = vi.fn();
    requireRoot(mockReq(makeUser({ isRoot: true })), mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when user is not root", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRoot(mockReq(makeUser({ isRoot: false })), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Root access required" });
  });

  it("returns 403 for admin who is not root", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRoot(mockReq(makeUser({ role: "admin", isRoot: false })), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 403 when no user on request", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRoot(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
