import { describe, it, expect, vi } from "vitest";
import { requireFeature, requireSuperAdminOrRoot } from "../require-role.js";
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

describe("requireFeature", () => {
  it("401 when there is no req.user", () => {
    const next = vi.fn();
    const res = mockRes();
    requireFeature("agent_config", "write")(mockReq(undefined), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("calls next() for root regardless of feature map", () => {
    const next = vi.fn();
    const res = mockRes();
    requireFeature("agent_config", "manage")(
      mockReq({
        username: "root",
        role: "admin",
        permissions: {},
        featurePermissions: {}, // empty — root bypasses
        isRoot: true,
      } as NonNullable<Request["user"]>),
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it("403 when feature level is below required", () => {
    const next = vi.fn();
    const res = mockRes();
    requireFeature("agent_config", "write")(
      mockReq({
        username: "alice",
        role: "operator",
        permissions: {},
        featurePermissions: { agent_config: "read" },
        isRoot: false,
      } as NonNullable<Request["user"]>),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("calls next() when feature level meets or exceeds required", () => {
    const next = vi.fn();
    const res = mockRes();
    requireFeature("agent_config", "write")(
      mockReq({
        username: "alice",
        role: "operator",
        permissions: {},
        featurePermissions: { agent_config: "manage" },
        isRoot: false,
      } as NonNullable<Request["user"]>),
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
  });
});

describe("requireSuperAdminOrRoot", () => {
  it("403 for admin", () => {
    const next = vi.fn();
    const res = mockRes();
    requireSuperAdminOrRoot(
      mockReq({ username: "a", role: "admin", permissions: {}, isRoot: false } as NonNullable<Request["user"]>),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("calls next() for super_admin", () => {
    const next = vi.fn();
    requireSuperAdminOrRoot(
      mockReq({ username: "sa", role: "super_admin", permissions: {}, isRoot: false } as NonNullable<Request["user"]>),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalled();
  });

  it("calls next() for root regardless of role", () => {
    const next = vi.fn();
    requireSuperAdminOrRoot(
      mockReq({ username: "root", role: "admin", permissions: {}, isRoot: true } as NonNullable<Request["user"]>),
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalled();
  });
});
