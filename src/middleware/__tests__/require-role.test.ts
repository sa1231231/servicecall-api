import { describe, it, expect, vi } from "vitest";
import {
  requireRole,
  requirePermission,
  requireRoot,
  requireRootForProtectedSlug,
  ROOT_ONLY_DELETE_SLUGS,
} from "../require-role.js";
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

// ── requireRootForProtectedSlug ─────────────────────────────────────────────

function mockReqWithSlug(slug: string, user?: Request["user"]): Request {
  return { params: { slug }, user } as unknown as Request;
}

describe("requireRootForProtectedSlug", () => {
  it("includes demo-hvac in the protected set", () => {
    expect(ROOT_ONLY_DELETE_SLUGS.has("demo-hvac")).toBe(true);
  });

  it("blocks non-root super_admin from deleting demo-hvac", () => {
    const next = vi.fn();
    const res = mockRes();
    const user = makeUser({ role: "super_admin", isRoot: false });
    requireRootForProtectedSlug(mockReqWithSlug("demo-hvac", user), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Root access required to delete this agent" });
  });

  it("blocks non-root admin from deleting demo-hvac", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRootForProtectedSlug(
      mockReqWithSlug("demo-hvac", makeUser({ role: "admin", isRoot: false })),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks non-root operator from deleting demo-hvac", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRootForProtectedSlug(
      mockReqWithSlug("demo-hvac", makeUser({ role: "operator", isRoot: false })),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows root user to delete demo-hvac", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRootForProtectedSlug(
      mockReqWithSlug("demo-hvac", makeUser({ isRoot: true })),
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows non-root super_admin to delete a non-protected slug", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRootForProtectedSlug(
      mockReqWithSlug("acme", makeUser({ role: "super_admin", isRoot: false })),
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("blocks request with no user when slug is protected", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRootForProtectedSlug(mockReqWithSlug("demo-hvac"), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("passes through when slug param is missing and slug is not protected", () => {
    const next = vi.fn();
    const res = mockRes();
    requireRootForProtectedSlug(
      { params: {}, user: makeUser({ isRoot: false }) } as unknown as Request,
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
  });
});
