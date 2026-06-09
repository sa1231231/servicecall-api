import { config } from "../config.js";

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
    const hits: PlacesHit[] = places.slice(0, count).map(mapApiPlace);
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

// ── Phone-number lookup channel ──────────────────────────────────────────────
//
// Yelp Fusion used to be the phone-→-business bridge. After dropping Yelp
// we replace it with Google's own phone resolver: the legacy Places "Find
// Place from Text" endpoint with `inputtype=phonenumber`. It returns a
// place_id, which we then hydrate against the New v1 `places/{id}` endpoint
// using the same FieldMask as `placesSearchText`. If hydration misses the
// website + hours (thin GBP, rare), we cascade to a textQuery by the
// resolved business name — same role the old `placesLookupByYelpHits`
// played, just sourcing the name from Google instead of Yelp.
//
// The legacy endpoint is deprecated for new project enablement but still
// live as of Jan 2026. Wrapper is fail-soft: a future sunset returns
// `{ ok: false, error }` and the bundle continues with stage-1 Places +
// CNAM + Brave + the model's `web_search` fallback.

const LEGACY_FINDPLACE_ENDPOINT = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json";
const PLACES_GETBYID_PREFIX = "https://places.googleapis.com/v1/places/";

/** Normalize a US phone string to E.164 (`+1...`). Returns null when the
 *  string can't be coerced to a 10-digit US number. Lifted from the old
 *  yelp-search.ts so the phone-lookup wrapper has no Yelp dependency. */
function toE164US(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  let ten = digits;
  if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
  if (ten.length !== 10) return null;
  return `+1${ten}`;
}

/** Map a single API place dict to our normalized PlacesHit shape. Shared
 *  between `placesSearchText` (which iterates `places[]`) and
 *  `placesGetById` (which gets one place at the response root). */
function mapApiPlace(p: PlacesApiPlace): PlacesHit {
  return {
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
  };
}

/** GET a Place by ID from the New v1 endpoint with the standard FieldMask.
 *  The single-place response has fields at the root (no `places[]` array)
 *  and the FieldMask shape is `displayName,formattedAddress,…` rather than
 *  the `places.<field>` shape `searchText` uses. */
export async function placesGetById(placeId: string): Promise<PlacesSearchResult> {
  const query = `placeId:${placeId}`;
  if (!config.GOOGLE_PLACES_API_KEY) {
    return { ok: false, query, hits: [], error: "GOOGLE_PLACES_API_KEY not configured" };
  }
  // Same fields as searchText, just without the `places.` prefix because
  // the single-place endpoint returns one Place at the root, not an array.
  const fieldMask = FIELD_MASK.split(",").map((f) => f.replace(/^places\./, "")).join(",");
  try {
    const res = await fetch(`${PLACES_GETBYID_PREFIX}${encodeURIComponent(placeId)}`, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": config.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
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
    const place = (await res.json()) as PlacesApiPlace;
    return { ok: true, query, hits: [mapApiPlace(place)] };
  } catch (err) {
    return {
      ok: false,
      query,
      hits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface LegacyFindPlaceCandidate {
  place_id?: string;
  name?: string;
  formatted_address?: string;
}

interface LegacyFindPlaceResponse {
  candidates?: LegacyFindPlaceCandidate[];
  status?: string;
  error_message?: string;
}

/** Reverse-resolve a US phone number to a Google Place. Cascade:
 *
 *   1. Legacy Find Place by phone → 0–1 candidate(s) with a `place_id`.
 *   2. Hydrate via New v1 `places/{id}` for website + hours + rating.
 *   3. If the hydrated result is thin (no website AND no hours), fall
 *      back to a textQuery by the resolved business name — this covers
 *      the case where Google has the listing under a slightly different
 *      Place ID than the phone-index points to.
 *
 *  Fail-soft like every other pre-search wrapper: missing key, non-US
 *  phone, legacy 4xx, or any network error returns `{ ok: false, error }`
 *  and the enrichment bundle continues.
 *
 *  `getByIdFn` and `textFn` are injectable for tests; production uses
 *  `placesGetById` and `placesSearchText`.
 */
export async function placesPhoneLookup(
  phone: string,
  getByIdFn: (placeId: string) => Promise<PlacesSearchResult> = placesGetById,
  textFn: (query: string) => Promise<PlacesSearchResult> = placesSearchText,
): Promise<PlacesSearchResult> {
  const query = `phone:${phone}`;
  if (!config.GOOGLE_PLACES_API_KEY) {
    return { ok: false, query, hits: [], error: "GOOGLE_PLACES_API_KEY not configured" };
  }
  const e164 = toE164US(phone);
  if (!e164) {
    return {
      ok: false,
      query,
      hits: [],
      error: "phone is not a 10-digit US number — Places phone lookup expects E.164",
    };
  }

  // 1. Legacy Find Place by phone.
  const params = new URLSearchParams({
    input: e164,
    inputtype: "phonenumber",
    // Cheapest field set: enough to get the place_id (for hydration) and
    // a fallback name (for the cascade). Hydration fetches the rich
    // fields. `formatted_address` is a free Basic Data field.
    fields: "place_id,name,formatted_address",
    key: config.GOOGLE_PLACES_API_KEY,
  });
  let candidate: LegacyFindPlaceCandidate | undefined;
  try {
    const res = await fetch(`${LEGACY_FINDPLACE_ENDPOINT}?${params.toString()}`);
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        query,
        hits: [],
        error: `Places legacy ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as LegacyFindPlaceResponse;
    // Legacy API: status="ZERO_RESULTS" on a clean miss, "OK" with
    // candidates on a hit. Any other status is a fail-soft error.
    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return {
        ok: false,
        query,
        hits: [],
        error: `Places legacy status=${data.status}${data.error_message ? `: ${data.error_message}` : ""}`,
      };
    }
    candidate = (data.candidates ?? [])[0];
  } catch (err) {
    return {
      ok: false,
      query,
      hits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!candidate || (!candidate.place_id && !candidate.name)) {
    return { ok: false, query, hits: [], error: "no Places phone match" };
  }

  // 2. Hydrate by Place ID when we have one (preferred path).
  if (candidate.place_id) {
    const hydrated = await getByIdFn(candidate.place_id);
    const hit = hydrated.hits[0];
    const thin = !hit || (!hit.website && (!hit.hours || hit.hours.length === 0));
    if (hydrated.ok && !thin) {
      // Hydrated by ID returned rich data — done. Re-stamp query so the
      // formatter renders the original phone, not "placeId:...".
      return { ...hydrated, query };
    }
    // 3. Fallback to text search by the resolved business name only when
    //    hydration is thin or errored. Skip if the candidate name is
    //    blank (no useful query to issue).
    const name = (candidate.name ?? "").trim();
    if (!name) {
      // Return the hydrated result as-is so the operator at least sees
      // the (partial) info we got from the place_id call.
      return { ...hydrated, query };
    }
    const fallback = await textFn(name);
    return { ...fallback, query };
  }

  // No place_id, but we have a name. Run the text-search fallback directly.
  const name = (candidate.name ?? "").trim();
  if (!name) {
    return { ok: false, query, hits: [], error: "no Places phone match" };
  }
  const fallback = await textFn(name);
  return { ...fallback, query };
}
