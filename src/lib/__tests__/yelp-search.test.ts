import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: { YELP_API_KEY: "test-yelp-key" },
}));

const { yelpPhoneSearch, formatYelpPhoneSearch } = await import("../yelp-search.js");

describe("yelpPhoneSearch", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn() as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("hits Yelp Fusion phone-search and parses a business hit", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        businesses: [
          {
            id: "abc",
            name: "Mr Fix It Handyman Services",
            url: "https://www.yelp.com/biz/mr-fix-it",
            phone: "+17654803157",
            display_phone: "(765) 480-3157",
            categories: [
              { alias: "handyman", title: "Handyman" },
              { alias: "plumbing", title: "Plumbing" },
            ],
            location: { display_address: ["208 E North St", "Galveston, IN 46932"] },
            rating: 5.0,
            review_count: 1,
            is_closed: false,
          },
        ],
        total: 1,
      }),
    });
    const out = await yelpPhoneSearch("7654803157");
    expect(out.ok).toBe(true);
    expect(out.phone).toBe("+17654803157");
    expect(out.hits).toHaveLength(1);
    const hit = out.hits[0];
    expect(hit.name).toBe("Mr Fix It Handyman Services");
    expect(hit.categories).toEqual(["Handyman", "Plumbing"]);
    expect(hit.address).toBe("208 E North St, Galveston, IN 46932");
    expect(hit.rating).toBe(5.0);
    expect(hit.reviewCount).toBe(1);

    const args = (global.fetch as any).mock.calls[0];
    expect(args[0]).toContain("api.yelp.com/v3/businesses/search/phone");
    expect(args[0]).toContain("phone=%2B17654803157");
    expect(args[1].headers.Authorization).toBe("Bearer test-yelp-key");
  });

  it("returns ok=true with empty hits when Yelp has no listing", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ businesses: [], total: 0 }),
    });
    const out = await yelpPhoneSearch("9999999999");
    expect(out.ok).toBe(true);
    expect(out.hits).toEqual([]);
  });

  it("returns ok=false on non-US numbers", async () => {
    const out = await yelpPhoneSearch("+44 20 7946 0958");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/E\.164|10-digit/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns ok=false on HTTP error without throwing", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const out = await yelpPhoneSearch("7654803157");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("429");
  });

  it("falls back to assembling address from address1/city/state when display_address is missing", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        businesses: [
          {
            name: "X",
            location: { address1: "1 Main St", city: "Galveston", state: "IN", zip_code: "46932" },
          },
        ],
      }),
    });
    const out = await yelpPhoneSearch("7654803157");
    expect(out.hits[0].address).toBe("1 Main St, Galveston, IN, 46932");
  });
});

describe("formatYelpPhoneSearch", () => {
  it("returns empty string for undefined input", () => {
    expect(formatYelpPhoneSearch(undefined)).toBe("");
  });

  it("renders an error block when the lookup failed", () => {
    const out = formatYelpPhoneSearch({
      ok: false,
      phone: "+17654803157",
      hits: [],
      error: "Yelp 429: rate limited",
    });
    expect(out).toContain("## Yelp phone-search results");
    expect(out).toContain("429");
  });

  it("renders 'no listing' when Yelp returned no hits", () => {
    const out = formatYelpPhoneSearch({ ok: true, phone: "+17654803157", hits: [] });
    expect(out).toContain("(no Yelp listing for +17654803157)");
  });

  it("renders the business name + categories + address + rating", () => {
    const out = formatYelpPhoneSearch({
      ok: true,
      phone: "+17654803157",
      hits: [
        {
          name: "Mr Fix It Handyman Services",
          url: "https://www.yelp.com/biz/mr-fix-it",
          categories: ["Handyman", "Plumbing"],
          address: "208 E North St, Galveston, IN 46932",
          rating: 5.0,
          reviewCount: 1,
          isClosed: false,
        },
      ],
    });
    expect(out).toContain("**Mr Fix It Handyman Services**");
    expect(out).toContain("https://www.yelp.com/biz/mr-fix-it");
    expect(out).toContain("categories: Handyman, Plumbing");
    expect(out).toContain("address: 208 E North St, Galveston, IN 46932");
    expect(out).toContain("rating: 5 (1 reviews)");
  });

  it("flags closed listings with a note", () => {
    const out = formatYelpPhoneSearch({
      ok: true,
      phone: "+17654803157",
      hits: [{ name: "Closed Co", categories: [], isClosed: true }],
    });
    expect(out).toContain("permanently closed on Yelp");
  });
});
