import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface YelpHit {
  name: string;
  url?: string;
  phone?: string;
  displayPhone?: string;
  /** Yelp categories like ["Plumbing", "Electricians", "Handyman"]. The
   *  first one usually maps cleanly to a service-vertical template. */
  categories: string[];
  /** Full address joined into one string (street, city, state, zip). */
  address?: string;
  rating?: number;
  reviewCount?: number;
  isClosed?: boolean;
  imageUrl?: string;
  /** "delivery" | "pickup" | "restaurant_reservation" — only present
   *  for verticals where Yelp tracks transactional support. */
  transactions?: string[];
}

export interface YelpPhoneSearchResult {
  ok: boolean;
  phone: string;
  hits: YelpHit[];
  error?: string;
}

// ── Internals ────────────────────────────────────────────────────────────────

const YELP_PHONE_ENDPOINT = "https://api.yelp.com/v3/businesses/search/phone";

interface YelpApiBusiness {
  id?: string;
  name?: string;
  url?: string;
  phone?: string;
  display_phone?: string;
  categories?: Array<{ alias?: string; title?: string }>;
  location?: {
    address1?: string;
    address2?: string;
    address3?: string;
    city?: string;
    state?: string;
    zip_code?: string;
    display_address?: string[];
  };
  rating?: number;
  review_count?: number;
  is_closed?: boolean;
  image_url?: string;
  transactions?: string[];
}

interface YelpApiResponse {
  businesses?: YelpApiBusiness[];
  total?: number;
}

/** Normalize a phone string to E.164 (`+1...`) — Yelp's phone-search
 *  endpoint requires it. Returns null when the string can't be coerced
 *  to a 10-digit US number. */
function toE164US(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  let ten = digits;
  if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
  if (ten.length !== 10) return null;
  return `+1${ten}`;
}

function joinAddress(loc?: YelpApiBusiness["location"]): string | undefined {
  if (!loc) return undefined;
  if (loc.display_address && loc.display_address.length > 0) {
    return loc.display_address.filter(Boolean).join(", ");
  }
  const parts = [
    loc.address1,
    loc.address2,
    loc.address3,
    loc.city,
    loc.state,
    loc.zip_code,
  ].filter((s): s is string => Boolean(s && s.trim()));
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function mapBusiness(b: YelpApiBusiness): YelpHit {
  return {
    name: b.name ?? "",
    url: b.url,
    phone: b.phone,
    displayPhone: b.display_phone,
    categories: (b.categories ?? [])
      .map((c) => c.title ?? c.alias ?? "")
      .filter(Boolean),
    address: joinAddress(b.location),
    rating: b.rating,
    reviewCount: b.review_count,
    isClosed: b.is_closed,
    imageUrl: b.image_url,
    transactions: b.transactions,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Search Yelp businesses by exact phone number. Fail-soft like the
 *  other pre-search wrappers: missing key, non-US number, or any HTTP
 *  error returns `{ ok: false, error }` and the bundle continues. */
export async function yelpPhoneSearch(phone: string): Promise<YelpPhoneSearchResult> {
  if (!config.YELP_API_KEY) {
    return { ok: false, phone, hits: [], error: "YELP_API_KEY not configured" };
  }
  const e164 = toE164US(phone);
  if (!e164) {
    return {
      ok: false,
      phone,
      hits: [],
      error: "phone is not a 10-digit US number — Yelp phone search expects E.164",
    };
  }
  const url = `${YELP_PHONE_ENDPOINT}?phone=${encodeURIComponent(e164)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.YELP_API_KEY}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        phone: e164,
        hits: [],
        error: `Yelp ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as YelpApiResponse;
    const businesses = data.businesses ?? [];
    return {
      ok: true,
      phone: e164,
      hits: businesses.map(mapBusiness),
    };
  } catch (err) {
    return {
      ok: false,
      phone: e164,
      hits: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Render the Yelp result as a markdown block. Yelp phone-match is a
 *  strong signal — when it returns a hit, the listing's `name` is
 *  almost always the canonical business name and `categories` maps
 *  directly to a service template. Surfaced second only to Places. */
export function formatYelpPhoneSearch(result?: YelpPhoneSearchResult): string {
  if (!result) return "";
  const lines: string[] = [
    "## Yelp phone-search results",
    "Yelp Fusion business search by exact phone number. **Strong signal** — when it returns a hit, the listing's name is the canonical business name (use it verbatim) and the categories map directly to a service vertical. Cross-check with Places when both return hits.",
    "",
  ];
  if (!result.ok) {
    lines.push(`*(error: ${result.error})*`);
    lines.push("");
    return lines.join("\n");
  }
  if (result.hits.length === 0) {
    lines.push(`*(no Yelp listing for ${result.phone})*`);
    lines.push("");
    return lines.join("\n");
  }
  for (const hit of result.hits) {
    lines.push(`- **${hit.name}**${hit.url ? ` — ${hit.url}` : ""}`);
    if (hit.categories.length > 0) lines.push(`  categories: ${hit.categories.join(", ")}`);
    if (hit.address) lines.push(`  address: ${hit.address}`);
    if (hit.displayPhone) lines.push(`  phone: ${hit.displayPhone}`);
    if (typeof hit.rating === "number") {
      lines.push(`  rating: ${hit.rating} (${hit.reviewCount ?? 0} reviews)`);
    }
    if (hit.isClosed === true) lines.push(`  **(marked permanently closed on Yelp)**`);
  }
  lines.push("");
  return lines.join("\n");
}
