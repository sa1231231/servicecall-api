import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: { GOOGLE_PLACES_API_KEY: "test-token" },
}));

const {
  buildPlacesQueries,
  formatPlacesPreSearch,
  placesSearchText,
  preSearchLeadPlaces,
  placesGetById,
  placesPhoneLookup,
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

// ── placesGetById — mocked fetch ─────────────────────────────────────────────

describe("placesGetById", () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = realFetch; });

  it("GETs the v1 single-place endpoint with a root-level FieldMask", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        displayName: { text: "Super Mario Auto" },
        formattedAddress: "123 Main St",
        websiteUri: "https://supermarioauto.com",
        regularOpeningHours: { weekdayDescriptions: ["Mon: 8am-6pm"] },
      }),
    });

    const out = await placesGetById("ChIJ_test_place_id");
    expect(out.ok).toBe(true);
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].name).toBe("Super Mario Auto");
    expect(out.hits[0].website).toBe("https://supermarioauto.com");
    expect(out.hits[0].hours).toEqual(["Mon: 8am-6pm"]);

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toContain("places.googleapis.com/v1/places/ChIJ_test_place_id");
    expect(init.method).toBe("GET");
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-token");
    // Single-place endpoint uses root-level field names (no `places.` prefix).
    expect(init.headers["X-Goog-FieldMask"]).toContain("displayName");
    expect(init.headers["X-Goog-FieldMask"]).not.toContain("places.displayName");
  });

  it("returns ok=false on non-2xx", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "place not found",
    });
    const out = await placesGetById("ChIJ_missing");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("404");
  });
});

// ── placesPhoneLookup — mocked legacy + injected hydration ──────────────────

describe("placesPhoneLookup", () => {
  const realFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn() as any; });
  afterEach(() => { global.fetch = realFetch; });

  // Mock the legacy Find Place response. Real legacy responses also have
  // `status: "OK"` or `"ZERO_RESULTS"` — include it so the wrapper's
  // status check works.
  function mockLegacy(candidates: Array<{ place_id?: string; name?: string; formatted_address?: string }>) {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: candidates.length > 0 ? "OK" : "ZERO_RESULTS",
        candidates,
      }),
    });
  }

  it("hits the legacy endpoint with inputtype=phonenumber and the E.164 phone", async () => {
    mockLegacy([]);
    await placesPhoneLookup("(973) 978-1542");
    const [url] = (global.fetch as any).mock.calls[0];
    expect(url).toContain("maps.googleapis.com/maps/api/place/findplacefromtext/json");
    expect(url).toContain("inputtype=phonenumber");
    // E.164 with `+` URL-encoded to `%2B`.
    expect(url).toContain("input=%2B19739781542");
    expect(url).toContain("fields=place_id");
  });

  it("happy path: legacy returns 1 candidate → hydrates via place_id → rich hit", async () => {
    mockLegacy([{ place_id: "ChIJ_arctic", name: "Arctic Blast Heating & Air" }]);
    const getById = vi.fn(async (id: string) => ({
      ok: true,
      query: `placeId:${id}`,
      hits: [{
        name: "Arctic Blast Heating & Air",
        website: "https://arcticblast.example",
        hours: ["Mon: 7am-7pm"],
      }],
    }));
    const text = vi.fn(async () => ({ ok: true, query: "x", hits: [] }));
    const out = await placesPhoneLookup("+19739781542", getById, text);
    expect(out.ok).toBe(true);
    expect(out.hits[0].name).toBe("Arctic Blast Heating & Air");
    expect(out.hits[0].website).toBe("https://arcticblast.example");
    expect(getById).toHaveBeenCalledWith("ChIJ_arctic");
    // Hydration was rich → textQuery fallback never fires.
    expect(text).not.toHaveBeenCalled();
    // Result re-stamps query to the phone, not "placeId:..." — keeps the
    // formatted Places block readable.
    expect(out.query).toBe("phone:+19739781542");
  });

  it("cascade: hydration returns a thin hit → falls back to textQuery by name", async () => {
    mockLegacy([{ place_id: "ChIJ_thin", name: "Acme Plumbing" }]);
    // Thin = no website AND no hours.
    const getById = vi.fn(async (id: string) => ({
      ok: true,
      query: `placeId:${id}`,
      hits: [{ name: "Acme Plumbing", address: "1 Main St" }],
    }));
    const text = vi.fn(async (q: string) => ({
      ok: true,
      query: q,
      hits: [{ name: "Acme Plumbing", website: "https://acmeplumbing.example", hours: ["Mon: 8am-5pm"] }],
    }));
    const out = await placesPhoneLookup("+12125550000", getById, text);
    expect(text).toHaveBeenCalledWith("Acme Plumbing");
    expect(out.ok).toBe(true);
    expect(out.hits[0].website).toBe("https://acmeplumbing.example");
  });

  it("cascade: hydration errors → still falls back to textQuery", async () => {
    mockLegacy([{ place_id: "ChIJ_err", name: "Bob's HVAC" }]);
    const getById = vi.fn(async () => ({ ok: false, query: "x", hits: [], error: "404" }));
    const text = vi.fn(async (q: string) => ({
      ok: true,
      query: q,
      hits: [{ name: "Bob's HVAC", website: "https://bobs.example" }],
    }));
    const out = await placesPhoneLookup("+13105550000", getById, text);
    expect(text).toHaveBeenCalledWith("Bob's HVAC");
    expect(out.ok).toBe(true);
  });

  it("no match: legacy returns 0 candidates → ok=false with descriptive error", async () => {
    mockLegacy([]);
    const getById = vi.fn();
    const text = vi.fn();
    const out = await placesPhoneLookup("+15555550000", getById, text);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no Places phone match");
    expect(getById).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("fail-soft on legacy 403 — returns ok=false without throwing", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "API key restricted",
    });
    const out = await placesPhoneLookup("+12485551234");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("403");
  });

  it("fail-soft on legacy REQUEST_DENIED status", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ status: "REQUEST_DENIED", error_message: "legacy endpoint sunset" }),
    });
    const out = await placesPhoneLookup("+12485551234");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("REQUEST_DENIED");
    expect(out.error).toContain("legacy endpoint sunset");
  });

  it("rejects non-US phone numbers without hitting the network", async () => {
    const fetchSpy = vi.fn();
    (global.fetch as any) = fetchSpy;
    const out = await placesPhoneLookup("not a phone");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("E.164");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
