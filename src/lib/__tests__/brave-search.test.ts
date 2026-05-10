import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: { BRAVE_API_KEY: "test-token" },
}));

const { buildBraveLeadQueries, formatBravePreSearch, braveWebSearch, preSearchLeadBrave } =
  await import("../brave-search.js");

// ── buildBraveLeadQueries — pure ─────────────────────────────────────────────

describe("buildBraveLeadQueries", () => {
  it("emits three formats for an 11-digit US phone number", () => {
    const queries = buildBraveLeadQueries({ phone: "+19739781542" });
    expect(queries).toEqual([
      `"973-978-1542"`,
      `"(973) 978-1542"`,
      `"+19739781542"`,
    ]);
  });

  it("emits one format for a 10-digit number", () => {
    const queries = buildBraveLeadQueries({ phone: "9739781542" });
    expect(queries[0]).toBe(`"973-978-1542"`);
  });

  it("falls back to raw quoted phone when length is unusual", () => {
    const queries = buildBraveLeadQueries({ phone: "+44 20 7946 0958" });
    expect(queries[0]).toBe(`"+44 20 7946 0958"`);
  });

  it("appends a name+business query when name is provided", () => {
    const queries = buildBraveLeadQueries({ phone: "+19739781542", name: "Mario Mina" });
    expect(queries[queries.length - 1]).toBe("Mario Mina business");
  });

  it("appends a site: query when website is provided", () => {
    const queries = buildBraveLeadQueries({
      website: "https://example.com",
    });
    expect(queries[queries.length - 1]).toBe("site:example.com");
  });

  it("returns no queries when input is empty", () => {
    expect(buildBraveLeadQueries({})).toEqual([]);
  });
});

// ── formatBravePreSearch — pure ──────────────────────────────────────────────

describe("formatBravePreSearch", () => {
  it("returns empty string when no searches were run", () => {
    expect(formatBravePreSearch({ searches: [] })).toBe("");
  });

  it("renders each search with its query, hits, and an error / empty fallback", () => {
    const out = formatBravePreSearch({
      searches: [
        {
          ok: true,
          query: `"973-978-1542"`,
          hits: [
            { title: "Super Mario Auto", url: "https://example.com/x", description: "Towing & repair." },
          ],
        },
        { ok: true, query: "Mario Mina business", hits: [] },
        { ok: false, query: "site:example.com", hits: [], error: "Brave 401: Unauthorized" },
      ],
    });
    expect(out).toContain("## Brave Search results");
    expect(out).toContain('### Query: `"973-978-1542"`');
    expect(out).toContain("**Super Mario Auto**");
    expect(out).toContain("Towing & repair.");
    expect(out).toContain("*(no results)*");
    expect(out).toContain("Brave 401: Unauthorized");
  });
});

// ── braveWebSearch — mocked fetch ────────────────────────────────────────────

describe("braveWebSearch", () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = realFetch; });

  it("hits the Brave endpoint with the API key header and parses results", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: "T1", url: "https://u1", description: "D1" },
            { title: "T2", url: "https://u2", description: "D2" },
          ],
        },
      }),
    });

    const out = await braveWebSearch(`"973-978-1542"`);
    expect(out.ok).toBe(true);
    expect(out.hits).toHaveLength(2);
    expect(out.hits[0]).toEqual({ title: "T1", url: "https://u1", description: "D1" });

    const fetchArgs = (global.fetch as any).mock.calls[0];
    expect(fetchArgs[0]).toContain("api.search.brave.com/res/v1/web/search");
    expect(fetchArgs[0]).toContain("q=%22973-978-1542%22");
    expect(fetchArgs[1].headers["X-Subscription-Token"]).toBe("test-token");
  });

  it("returns ok=false with an error message on non-2xx", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const out = await braveWebSearch("anything");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("429");
  });

  it("returns ok=false on network error without throwing", async () => {
    (global.fetch as any).mockRejectedValue(new Error("ECONNRESET"));
    const out = await braveWebSearch("anything");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("ECONNRESET");
  });
});

// ── preSearchLeadBrave — runs every query sequentially ──────────────────────

describe("preSearchLeadBrave", () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = realFetch; });

  it("runs one search per query and returns them all", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });
    const out = await preSearchLeadBrave({ phone: "+19739781542", name: "Mario Mina" });
    // 3 phone-format queries + 1 name query
    expect(out.searches).toHaveLength(4);
    expect((global.fetch as any).mock.calls).toHaveLength(4);
  });

  it("short-circuits to empty when BRAVE_API_KEY is unset", async () => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({ config: { BRAVE_API_KEY: "" } }));
    const fresh = await import("../brave-search.js");
    const out = await fresh.preSearchLeadBrave({ phone: "+19739781542" });
    expect(out.searches).toEqual([]);
    vi.doUnmock("../../config.js");
    vi.resetModules();
  });
});
