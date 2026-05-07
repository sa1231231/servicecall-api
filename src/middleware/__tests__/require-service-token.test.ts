import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const { mockConfig } = vi.hoisted(() => ({ mockConfig: { LEAD_INTAKE_TOKEN: "" } }));
vi.mock("../../config.js", () => ({ config: mockConfig }));

const { requireServiceToken } = await import("../require-service-token.js");

function makeRes() {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res as Response & { _status: number; _json: any };
}

function call(authHeader: string | undefined): { res: any; nextCalled: boolean } {
  const req = { headers: authHeader === undefined ? {} : { authorization: authHeader } } as unknown as Request;
  const res = makeRes();
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  requireServiceToken(req, res, next);
  return { res, nextCalled };
}

describe("requireServiceToken", () => {
  beforeEach(() => { mockConfig.LEAD_INTAKE_TOKEN = ""; });

  it("returns 401 when LEAD_INTAKE_TOKEN env is unset", () => {
    const { res, nextCalled } = call("Bearer anything");
    expect(res._status).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("returns 401 when Authorization header is missing", () => {
    mockConfig.LEAD_INTAKE_TOKEN = "secret";
    const { res, nextCalled } = call(undefined);
    expect(res._status).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("returns 401 on a wrong token", () => {
    mockConfig.LEAD_INTAKE_TOKEN = "secret";
    const { res, nextCalled } = call("Bearer wrong");
    expect(res._status).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("returns 401 when the prefix isn't Bearer", () => {
    mockConfig.LEAD_INTAKE_TOKEN = "secret";
    const { res, nextCalled } = call("Token secret");
    expect(res._status).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it("calls next() on a matching Bearer token (case-insensitive prefix)", () => {
    mockConfig.LEAD_INTAKE_TOKEN = "secret-abc-123";
    const { res, nextCalled } = call("bearer secret-abc-123");
    expect(res._status).toBe(200);
    expect(nextCalled).toBe(true);
  });
});
