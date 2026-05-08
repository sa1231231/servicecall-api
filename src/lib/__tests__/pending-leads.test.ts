import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory shim for the `pending_leads` collection. The mocked `getDb()`
// returns an object whose `.collection()` proxies to these vi.fn() handles
// so each test can program a return value AND inspect the call shape.
const {
  mockInsertOne, mockFind, mockFindOne, mockUpdateOne,
} = vi.hoisted(() => ({
  mockInsertOne: vi.fn(),
  mockFind: vi.fn(),
  mockFindOne: vi.fn(),
  mockUpdateOne: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: (_name: string) => ({
      insertOne: mockInsertOne,
      find: mockFind,
      findOne: mockFindOne,
      updateOne: mockUpdateOne,
    }),
  }),
}));

const {
  createPendingLead,
  listPendingLeads,
  getPendingLead,
  updatePendingLead,
  markPromoted,
  markDismissed,
  findPendingLeadByExternalId,
} = await import("../pending-leads.js");

beforeEach(() => {
  for (const m of [mockInsertOne, mockFind, mockFindOne, mockUpdateOne]) m.mockReset();
  mockInsertOne.mockResolvedValue({ acknowledged: true });
  mockUpdateOne.mockResolvedValue({ acknowledged: true });
});

describe("createPendingLead", () => {
  it("inserts a queued lead with a fresh _id, returns the lead", async () => {
    const lead = await createPendingLead({
      source: "manual",
      input: { name: "Acme Plumbing", phone: "+15551112222" },
    });
    expect(lead.status).toBe("queued");
    expect(lead.source).toBe("manual");
    expect(lead.input).toEqual({ name: "Acme Plumbing", phone: "+15551112222" });
    expect(lead._id).toMatch(/^[0-9a-f]{32}$/);
    // createdAt and updatedAt are ISO strings, both stamped at "now".
    // They come from two separate `new Date().toISOString()` calls so they
    // can differ by ≤ 1 ms — assert ordering, not equality.
    expect(lead.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lead.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(lead.updatedAt).getTime() - new Date(lead.createdAt).getTime())
      .toBeLessThanOrEqual(50);
    // The doc that hit Mongo matches what we returned.
    expect(mockInsertOne).toHaveBeenCalledWith(lead);
  });

  it("returns unique IDs across calls (collision-free entropy)", async () => {
    const a = await createPendingLead({ source: "manual", input: { name: "A" } });
    const b = await createPendingLead({ source: "manual", input: { name: "B" } });
    expect(a._id).not.toBe(b._id);
  });

  it("preserves whatever shape the caller passed for `source` (e.g. 'sheet')", async () => {
    const lead = await createPendingLead({ source: "sheet", input: { name: "X" } });
    expect(lead.source).toBe("sheet");
  });
});

describe("listPendingLeads", () => {
  // The handler chains find().sort().toArray(); chain proxy returns the docs.
  function setListResult(docs: any[]) {
    mockFind.mockReturnValue({
      sort: () => ({ toArray: async () => docs }),
    });
  }

  it("excludes terminal statuses by default ($nin: promoted, dismissed)", async () => {
    setListResult([{ _id: "1" }]);
    await listPendingLeads();
    expect(mockFind).toHaveBeenCalledWith({
      status: { $nin: ["promoted", "dismissed"] },
    });
  });

  it("filters to a single status when one is given (overrides the default $nin)", async () => {
    setListResult([]);
    await listPendingLeads({ status: "ready" });
    expect(mockFind).toHaveBeenCalledWith({ status: "ready" });
  });

  it("includes terminal statuses when includeTerminal=true", async () => {
    setListResult([]);
    await listPendingLeads({ includeTerminal: true });
    // No status filter at all when terminals are included and no specific status requested.
    expect(mockFind).toHaveBeenCalledWith({});
  });

  it("returns the docs straight through (newest-first ordering is the lib's contract)", async () => {
    setListResult([{ _id: "newer" }, { _id: "older" }]);
    const out = await listPendingLeads();
    expect(out).toEqual([{ _id: "newer" }, { _id: "older" }]);
  });
});

describe("getPendingLead", () => {
  it("looks up by _id", async () => {
    mockFindOne.mockResolvedValue({ _id: "abc", status: "ready" });
    const out = await getPendingLead("abc");
    expect(mockFindOne).toHaveBeenCalledWith({ _id: "abc" });
    expect(out).toEqual({ _id: "abc", status: "ready" });
  });

  it("returns null when missing", async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await getPendingLead("missing")).toBeNull();
  });
});

describe("updatePendingLead", () => {
  it("applies the field updates and bumps updatedAt", async () => {
    mockFindOne.mockResolvedValue({ _id: "lead1", status: "ready" });
    const before = new Date().toISOString();
    await updatePendingLead("lead1", { status: "ready", enrichmentError: undefined });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "lead1" });
    expect(update.$set.status).toBe("ready");
    expect(update.$set.enrichmentError).toBeUndefined();
    // updatedAt was set to a fresh ISO timestamp.
    expect(update.$set.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(update.$set.updatedAt >= before).toBe(true);
  });

  it("returns the (re-fetched) doc, not the update result", async () => {
    mockFindOne.mockResolvedValue({ _id: "lead1", status: "ready", input: { name: "Acme" } });
    const out = await updatePendingLead("lead1", { status: "ready" });
    expect(out).toEqual({ _id: "lead1", status: "ready", input: { name: "Acme" } });
    expect(mockFindOne).toHaveBeenCalledWith({ _id: "lead1" });
  });

  it("merges editable input field changes (not just enriched/status)", async () => {
    mockFindOne.mockResolvedValue({ _id: "lead1" });
    const newInput = { name: "Edited", phone: "+15559998888" };
    await updatePendingLead("lead1", { input: newInput });
    const [, update] = mockUpdateOne.mock.calls[0];
    expect(update.$set.input).toEqual(newInput);
  });

  it("returns null when the lead vanished between update and re-fetch", async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await updatePendingLead("lead1", { status: "dismissed" })).toBeNull();
  });
});

describe("markPromoted", () => {
  it("flips status to promoted and stamps the resulting agent slug", async () => {
    await markPromoted("lead1", "acme-plumbing");
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "lead1" });
    expect(update.$set.status).toBe("promoted");
    expect(update.$set.promotedSlug).toBe("acme-plumbing");
    expect(update.$set.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("createPendingLead with externalId / status overrides", () => {
  it("stamps externalId on the doc when provided", async () => {
    const lead = await createPendingLead({
      source: "google_sheet",
      input: { name: "Meta Lead" },
      externalId: "l:1574729760257730",
    });
    expect(lead.externalId).toBe("l:1574729760257730");
    expect(mockInsertOne).toHaveBeenCalledWith(lead);
  });

  it("omits externalId from the doc when not provided", async () => {
    const lead = await createPendingLead({ source: "manual", input: { name: "X" } });
    expect(lead).not.toHaveProperty("externalId");
    expect(mockInsertOne.mock.calls[0][0]).not.toHaveProperty("externalId");
  });

  it("honors a status override (used by the backfill seed)", async () => {
    const lead = await createPendingLead({
      source: "meta_lead_ads_backfill",
      input: { name: "(backfill)" },
      externalId: "l:9999",
      status: "dismissed",
    });
    expect(lead.status).toBe("dismissed");
  });
});

describe("findPendingLeadByExternalId", () => {
  it("looks up by externalId", async () => {
    mockFindOne.mockResolvedValue({ _id: "abc", externalId: "l:1", status: "ready" });
    const out = await findPendingLeadByExternalId("l:1");
    expect(mockFindOne).toHaveBeenCalledWith({ externalId: "l:1" });
    expect(out?._id).toBe("abc");
  });

  it("returns null when unknown", async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await findPendingLeadByExternalId("l:nope")).toBeNull();
  });
});

describe("markDismissed", () => {
  it("flips status to dismissed without touching promotedSlug", async () => {
    await markDismissed("lead1");
    const [filter, update] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "lead1" });
    expect(update.$set.status).toBe("dismissed");
    expect(update.$set.promotedSlug).toBeUndefined();
    expect(update.$set.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
