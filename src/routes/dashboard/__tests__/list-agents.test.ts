import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── Mocks ──────────────────────────────────────────────────────────────────

const { mockGetAllClientDocuments } = vi.hoisted(() => ({
  mockGetAllClientDocuments: vi.fn(),
}));

vi.mock("../../../config/client-store.js", () => ({
  getAllClientDocuments: (...args: any[]) => mockGetAllClientDocuments(...args),
}));

// list-agents.ts imports billing-cogs.js, which transitively pulls in db.js
// and config.js. Mock billing-cogs to keep that chain out of the test worker.
vi.mock("../../../lib/billing-cogs.js", () => ({
  getMtdCogsForAllClients: vi.fn().mockResolvedValue({}),
}));

import { listAgentsHandler } from "../list-agents.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mockRes(): Response & { _status: number; _json: any } {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

function makeDoc(overrides: Record<string, any> = {}) {
  return {
    _id: "test-co",
    name: "Test Co",
    shadow_mode: false,
    agent_id: "agent_1",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAgentsHandler", () => {
  it("includes active field in response", async () => {
    mockGetAllClientDocuments.mockResolvedValue([
      makeDoc({ active: true }),
    ]);

    const res = mockRes();
    await listAgentsHandler({} as Request, res);

    expect(res._json).toHaveLength(1);
    expect(res._json[0].active).toBe(true);
  });

  it("returns active: undefined when not set on document", async () => {
    mockGetAllClientDocuments.mockResolvedValue([
      makeDoc(), // no active field
    ]);

    const res = mockRes();
    await listAgentsHandler({} as Request, res);

    expect(res._json[0].active).toBeUndefined();
  });

  it("returns active: false for inactive agents", async () => {
    mockGetAllClientDocuments.mockResolvedValue([
      makeDoc({ active: false }),
    ]);

    const res = mockRes();
    await listAgentsHandler({} as Request, res);

    expect(res._json[0].active).toBe(false);
  });

  it("defaults trial_start_date to null when missing", async () => {
    mockGetAllClientDocuments.mockResolvedValue([
      makeDoc(), // no trial_start_date
    ]);

    const res = mockRes();
    await listAgentsHandler({} as Request, res);

    expect(res._json[0].trial_start_date).toBeNull();
  });
});
