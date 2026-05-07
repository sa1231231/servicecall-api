import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: { GOOGLE_PLACES_API_KEY: "test-token" },
}));

const {
  buildPlacesQueries,
  formatPlacesPreSearch,
  placesSearchText,
  preSearchLeadPlaces,
} = await import("../google-places.js");

// ── buildPlacesQueries — pure ────────────────────────────────────────────────

describe("buildPlacesQueries", () => {
  it("formats an 11-digit US phone as `(NNN) NNN-NNNN`", () => {
    expect(buildPlacesQueries({ phone: "+19739781542" })[0]).toBe("(973) 978-1542");
  });

  it("falls back to the raw phone when length is unusual", () => {
    expect(buildPlacesQueries({ phone: "+44 20 7946 0958" })[0]).toBe("+44 20 7946 0958");
  });

  it("appends the name as a second query", () => {
    const queries = buildPlacesQueries({ phone: "+19739781542", name: "Mario Mina" });
    expect(queries).toEqual(["(973) 978-1542", "Mario Mina"]);
  });

  it("returns nothing for an empty input", () => {
    expect(buildPlacesQueries({})).toEqual([]);
  });
});

// ── formatPlacesPreSearch — pure ─────────────────────────────────────────────

describe("formatPlacesPreSearch", () => {
  it("returns empty string when no searches were run", () => {
    expect(formatPlacesPreSearch({ searches: [] })).toBe("");
  });

  it("renders every populated field on its own line", () => {
    const out = formatPlacesPreSearch({
      searches: [
        {
          ok: true,
          query: "(973) 978-1542",
          hits: [
            {
              name: "Super Mario Auto Repair",
              primaryType: "car_repair",
              types: ["car_repair", "establishment"],
              address: "123 Main St, Elmwood Park, NJ",
              phone: "(973) 978-1542",
              website: "https://supermarioauto.com",
              hours: ["Mon: 8am-6pm", "Tue: 8am-6pm"],
              rating: 4.7,
              reviewCount: 120,
              summary: "Family-owned auto repair shop.",
            },
          ],
        },
        { ok: true, query: "no hits", hits: [] },
        { ok: false, query: "errored", hits: [], error: "Places 403: forbidden" },
      ],
    });
    expect(out).toContain("## Google Places results");
    expect(out).toContain("**Super Mario Auto Repair**");
    expect(out).toContain("type: car_repair");
    expect(out).toContain("123 Main St");
    expect(out).toContain("(973) 978-1542");
    expect(out).toContain("Mon: 8am-6pm; Tue: 8am-6pm");
    expect(out).toContain("rating: 4.7 (120 reviews)");
    expect(out).toContain("Family-owned auto repair shop.");
    expect(out).toContain("*(no results)*");
    expect(out).toContain("Places 403: forbidden");
  });
});

// ── placesSearchText — mocked fetch ──────────────────────────────────────────

describe("placesSearchText", () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = realFetch; });

  it("POSTs to the Places New endpoint with the API key + FieldMask headers", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        places: [
          {
            displayName: { text: "Super Mario Auto" },
            formattedAddress: "123 Main",
            nationalPhoneNumber: "(973) 978-1542",
            primaryType: "car_repair",
            rating: 4.7,
            userRatingCount: 120,
          },
        ],
      }),
    });

    const out = await placesSearchText("(973) 978-1542");
    expect(out.ok).toBe(true);
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].name).toBe("Super Mario Auto");
    expect(out.hits[0].phone).toBe("(973) 978-1542");
    expect(out.hits[0].primaryType).toBe("car_repair");

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-token");
    expect(init.headers["X-Goog-FieldMask"]).toContain("places.displayName");
    expect(JSON.parse(init.body).textQuery).toBe("(973) 978-1542");
  });

  it("returns ok=false on non-2xx with a truncated error message", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "API key restricted to wrong service",
    });
    const out = await placesSearchText("anything");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("403");
  });

  it("falls back to internationalPhoneNumber when nationalPhoneNumber is absent", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        places: [
          {
            displayName: { text: "X" },
            internationalPhoneNumber: "+1 973-978-1542",
          },
        ],
      }),
    });
    const out = await placesSearchText("x");
    expect(out.hits[0].phone).toBe("+1 973-978-1542");
  });

  it("survives a network error without throwing", async () => {
    (global.fetch as any).mockRejectedValue(new Error("ECONNRESET"));
    const out = await placesSearchText("x");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("ECONNRESET");
  });
});

// ── preSearchLeadPlaces — runs every query ───────────────────────────────────

describe("preSearchLeadPlaces", () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = realFetch; });

  it("hits Places once per query in buildPlacesQueries", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ places: [] }),
    });
    const out = await preSearchLeadPlaces({ phone: "+19739781542", name: "Mario Mina" });
    expect(out.searches).toHaveLength(2);
    expect((global.fetch as any).mock.calls).toHaveLength(2);
  });
});
