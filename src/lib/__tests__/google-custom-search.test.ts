import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    GOOGLE_CUSTOM_SEARCH_API_KEY: "test-key",
    GOOGLE_CUSTOM_SEARCH_CX: "test-cx",
  },
}));

const {
  buildCustomLeadQueries,
  formatCustomPreSearch,
  customWebSearch,
  preSearchLeadCustom,
} = await import("../google-custom-search.js");

// ── buildCustomLeadQueries — pure ────────────────────────────────────────────

describe("buildCustomLeadQueries", () => {
  it("emits three formats for an 11-digit US phone number", () => {
    const queries = buildCustomLeadQueries({ phone: "+19739781542" });
    expect(queries).toEqual(["973-978-1542", "(973) 978-1542", "+19739781542"]);
  });

  it("strips the Meta `p:+1...` prefix and emits all three formats", () => {
    const queries = buildCustomLeadQueries({ phone: "p:+17654803157" });
    expect(queries).toEqual(["765-480-3157", "(765) 480-3157", "+17654803157"]);
  });

  it("emits three formats for a 10-digit number", () => {
    const queries = buildCustomLeadQueries({ phone: "9739781542" });
    expect(queries).toEqual(["973-978-1542", "(973) 978-1542", "+19739781542"]);
  });

  it("falls back to raw phone when length is unusual", () => {
    const queries = buildCustomLeadQueries({ phone: "+44 20 7946 0958" });
    expect(queries[0]).toBe("+44 20 7946 0958");
  });

  it("appends a name+business query when name is provided", () => {
    const queries = buildCustomLeadQueries({ phone: "+19739781542", name: "Mario Mina" });
    expect(queries[queries.length - 1]).toBe("Mario Mina business");
  });

  it("appends a site: query when website is provided (strips scheme)", () => {
    const queries = buildCustomLeadQueries({ website: "https://example.com" });
    expect(queries[queries.length - 1]).toBe("site:example.com");
  });

  it("returns no queries when input is empty", () => {
    expect(buildCustomLeadQueries({})).toEqual([]);
  });
});

// ── formatCustomPreSearch — pure ─────────────────────────────────────────────

describe("formatCustomPreSearch", () => {
  it("returns empty string when no searches were run", () => {
    expect(formatCustomPreSearch({ searches: [] })).toBe("");
  });

  it("renders each search with its query, hits, and error/empty fallbacks", () => {
    const out = formatCustomPreSearch({
      searches: [
        {
          ok: true,
          query: "973-978-1542",
          hits: [
            { title: "Super Mario Auto", url: "https://example.com/x", description: "Towing & repair." },
          ],
        },
        { ok: true, query: "Mario Mina business", hits: [] },
        { ok: false, query: "site:example.com", hits: [], error: "Custom Search 403: forbidden" },
      ],
    });
    expect(out).toContain("## Google Custom Search results");
    expect(out).toContain("### Query: `973-978-1542`");
    expect(out).toContain("**Super Mario Auto**");
    expect(out).toContain("Towing & repair.");
    expect(out).toContain("*(no results)*");
    expect(out).toContain("Custom Search 403: forbidden");
  });
});

// ── customWebSearch — mocked fetch ───────────────────────────────────────────

describe("customWebSearch", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn() as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("hits the Custom Search endpoint with key + cx and parses items", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { title: "T1", link: "https://u1", snippet: "D1" },
          { title: "T2", link: "https://u2", snippet: "D2" },
        ],
      }),
    });

    const out = await customWebSearch("765-480-3157");
    expect(out.ok).toBe(true);
    expect(out.hits).toHaveLength(2);
    expect(out.hits[0]).toEqual({ title: "T1", url: "https://u1", description: "D1" });

    const fetchArgs = (global.fetch as any).mock.calls[0];
    expect(fetchArgs[0]).toContain("customsearch.googleapis.com/customsearch/v1");
    expect(fetchArgs[0]).toContain("key=test-key");
    expect(fetchArgs[0]).toContain("cx=test-cx");
    expect(fetchArgs[0]).toContain("q=765-480-3157");
  });

  it("returns ok=false with an error message on non-2xx", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const out = await customWebSearch("anything");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("429");
  });

  it("returns ok=false on network error without throwing", async () => {
    (global.fetch as any).mockRejectedValue(new Error("ECONNRESET"));
    const out = await customWebSearch("anything");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("ECONNRESET");
  });

  it("handles a missing items array (zero hits)", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const out = await customWebSearch("anything");
    expect(out.ok).toBe(true);
    expect(out.hits).toEqual([]);
  });
});

// ── preSearchLeadCustom — runs every query sequentially ──────────────────────

describe("preSearchLeadCustom", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn() as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("runs one search per query and returns them all", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    const out = await preSearchLeadCustom({ phone: "+19739781542", name: "Mario Mina" });
    // 3 phone-format queries + 1 name query
    expect(out.searches).toHaveLength(4);
    expect((global.fetch as any).mock.calls).toHaveLength(4);
  });
});
