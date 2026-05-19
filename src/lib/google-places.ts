import { config } from "../config.js";
import type { YelpPhoneSearchResult } from "./yelp-search.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlacesHit {
  name: string;
  address?: string;
  phone?: string;
  website?: string;
  hours?: string[];
  primaryType?: string;
  types?: string[];
  rating?: number;
  reviewCount?: number;
  summary?: string;
}

export interface PlacesSearchResult {
  ok: boolean;
  query: string;
  hits: PlacesHit[];
  error?: string;
}

export interface PlacesPreSearchInput {
  name?: string;
  phone?: string;
}

export interface PlacesPreSearchResult {
  searches: PlacesSearchResult[];
}

// ── Internals ────────────────────────────────────────────────────────────────

const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

// FieldMask is required and gates response cost. Keep it tight: just the
// fields the skill actually uses to identify the business and write FAQs.
const FIELD_MASK = [
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.regularOpeningHours.weekdayDescriptions",
  "places.types",
  "places.primaryType",
  "places.rating",
  "places.userRatingCount",
  "places.editorialSummary",
].join(",");

interface PlacesApiPlace {
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  types?: string[];
  primaryType?: string;
  rating?: number;
  userRatingCount?: number;
  editorialSummary?: { text?: string };
}

/** Single Places searchText call. Returns the top `count` hits as a
 *  normalized shape. Errors don't throw — they're returned with
 *  `ok: false` so the caller can keep going. */
export async function placesSearchText(query: string, count = 5): Promise<PlacesSearchResult> {
  if (!config.GOOGLE_PLACES_API_KEY) {
    return { ok: false, query, hits: [], error: "GOOGLE_PLACES_API_KEY not configured" };
  }
  try {
    const res = await fetch(PLACES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": config.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, pageSize: count }),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        query,
        hits: [],
        error: `Places ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { places?: PlacesApiPlace[] };
    const places = data?.places ?? [];
    const hits: PlacesHit[] = places.slice(0, count).map((p) => ({
      name: p.displayName?.text ?? "",
      address: p.formattedAddress,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber,
      website: p.websiteUri,
      hours: p.regularOpeningHours?.weekdayDescriptions,
      primaryType: p.primaryType,
      types: p.types,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      summary: p.editorialSummary?.text,
    }));
    return { ok: true, query, hits };
  } catch (err) {
    return {
      ok: false,
      query,
      hits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build the list of textQuery strings we run for a given lead. Phone
 *  number first (formatted), then name as fallback. Places' textQuery
 *  is permissive — no need for multiple punctuation variants the way
 *  Brave's quoted-phrase matching demands. */
export function buildPlacesQueries(input: PlacesPreSearchInput): string[] {
  const queries: string[] = [];
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, "");
    let ten = digits;
    if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
    if (ten.length === 10) {
      queries.push(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
    } else {
      queries.push(input.phone);
    }
  }
  if (input.name) {
    queries.push(input.name);
  }
  return queries;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Run the Places pre-search bundle for a lead. Sequential to keep the
 *  request rate reasonable (Places quota is generous but per-second
 *  limits exist on free tier). */
export async function preSearchLeadPlaces(
  input: PlacesPreSearchInput,
): Promise<PlacesPreSearchResult> {
  const queries = buildPlacesQueries(input);
  const searches: PlacesSearchResult[] = [];
  for (const q of queries) {
    searches.push(await placesSearchText(q));
  }
  return { searches };
}

/** Render the Places result as a markdown block to embed in the user
 *  message we send to the skill. Each hit lists every populated field
 *  on its own line so the skill can grep facts without parsing JSON. */
export function formatPlacesPreSearch(result: PlacesPreSearchResult): string {
  if (result.searches.length === 0) return "";
  const lines: string[] = [
    "## Google Places results (authoritative)",
    "These are Google Business Profile listings — the strongest signal for who this lead belongs to. The phone-matched listing wins. If a Places hit names a business, **commit to that name** in the JSON output.",
    "",
  ];
  for (const search of result.searches) {
    lines.push(`### Query: \`${search.query}\``);
    if (!search.ok) {
      lines.push(`*(error: ${search.error})*`);
    } else if (search.hits.length === 0) {
      lines.push("*(no results)*");
    } else {
      for (const hit of search.hits) {
        lines.push(`- **${hit.name}**`);
        if (hit.primaryType) {
          const others = (hit.types ?? []).filter((t) => t !== hit.primaryType).slice(0, 4);
          const extra = others.length > 0 ? ` (also: ${others.join(", ")})` : "";
          lines.push(`  type: ${hit.primaryType}${extra}`);
        }
        if (hit.address) lines.push(`  address: ${hit.address}`);
        if (hit.phone) lines.push(`  phone: ${hit.phone}`);
        if (hit.website) lines.push(`  website: ${hit.website}`);
        if (hit.hours && hit.hours.length > 0) {
          lines.push(`  hours: ${hit.hours.join("; ")}`);
        }
        if (typeof hit.rating === "number") {
          lines.push(`  rating: ${hit.rating} (${hit.reviewCount ?? 0} reviews)`);
        }
        if (hit.summary) lines.push(`  summary: ${hit.summary}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Second-stage Places lookup keyed by the business name Yelp's phone-match
 * resolved. Places `searchText` does NOT resolve a bare phone number, and a
 * lead's `name` is often a person — so the first-pass queries (phone, then
 * lead name) routinely miss the business entirely. Yelp's phone-match
 * reliably yields the canonical business name; feeding that back into Places
 * by name is what surfaces the GBP `websiteUri` (+ hours) that Yelp Fusion
 * itself never returns.
 *
 * `alreadyQueried` are the first-pass query strings — skip any name already
 * covered so we don't pay for a duplicate call. Caps at 2 extra Places
 * queries; blank/duplicate Yelp names don't consume the cap.
 * `searchFn` is injectable for tests; production uses `placesSearchText`.
 */
export async function placesLookupByYelpHits(
  yelp: YelpPhoneSearchResult | undefined,
  alreadyQueried: string[],
  searchFn: (query: string) => Promise<PlacesSearchResult> = placesSearchText,
): Promise<PlacesSearchResult[]> {
  if (!yelp || !yelp.ok || yelp.hits.length === 0) return [];
  const seen = new Set(alreadyQueried.map((q) => q.trim().toLowerCase()));
  const results: PlacesSearchResult[] = [];
  for (const hit of yelp.hits) {
    if (results.length >= 2) break;
    const name = (hit.name ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    results.push(await searchFn(name));
  }
  return results;
}
