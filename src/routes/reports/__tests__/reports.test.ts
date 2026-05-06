import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

const { mockRunWeeklyReports } = vi.hoisted(() => ({
  mockRunWeeklyReports: vi.fn(),
}));

vi.mock("../../../lib/weekly-report.js", () => ({
  runWeeklyReports: (...args: any[]) => mockRunWeeklyReports(...args),
}));

const { reportsRouter } = await import("../index.js");

function makeRes() {
  const res: any = { _status: 200, _json: null };
  res.status = (c: number) => { res._status = c; return res; };
  res.json = (d: any) => { res._json = d; return res; };
  return res as Response & { _status: number; _json: any };
}

function makeReq(query: Record<string, string> = {}): Request {
  return { query, params: {}, body: {} } as any;
}

async function runRoute(method: string, path: string, req: Request, res: Response) {
  const layer = (reportsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  for (const s of layer.route.stack) {
    let advance = false;
    let err: any = null;
    const next: NextFunction = (e?: any) => { if (e) err = e; advance = true; };
    const result = s.handle(req, res, next);
    if (result && typeof result.then === "function") await result;
    if (err) throw err;
    if (!advance) return;
  }
}

beforeEach(() => {
  mockRunWeeklyReports.mockReset();
});

describe("POST /reports/weekly", () => {
  it("calls runWeeklyReports() with no clientId when client_id query is absent", async () => {
    mockRunWeeklyReports.mockResolvedValue({ sent: 3, skipped: 1 });
    const res = makeRes();

    await runRoute("post", "/weekly", makeReq(), res);

    expect(mockRunWeeklyReports).toHaveBeenCalledWith(undefined);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ success: true, sent: 3, skipped: 1 });
  });

  it("forwards client_id from query string", async () => {
    mockRunWeeklyReports.mockResolvedValue({ sent: 1 });
    const res = makeRes();

    await runRoute("post", "/weekly", makeReq({ client_id: "acme" }), res);

    expect(mockRunWeeklyReports).toHaveBeenCalledWith("acme");
    expect(res._json).toEqual({ success: true, sent: 1 });
  });

  it("treats empty client_id as no filter", async () => {
    mockRunWeeklyReports.mockResolvedValue({});
    const res = makeRes();

    await runRoute("post", "/weekly", makeReq({ client_id: "" }), res);

    expect(mockRunWeeklyReports).toHaveBeenCalledWith(undefined);
  });

  it("returns 500 with error message when runWeeklyReports rejects", async () => {
    mockRunWeeklyReports.mockRejectedValue(new Error("smtp down"));
    const res = makeRes();

    await runRoute("post", "/weekly", makeReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: "smtp down" });
  });

  it("returns 500 with 'Unknown error' for non-Error throws", async () => {
    mockRunWeeklyReports.mockRejectedValue("not-an-error");
    const res = makeRes();

    await runRoute("post", "/weekly", makeReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: "Unknown error" });
  });
});
