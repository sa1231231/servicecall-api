import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CustomSearchHit {
  title: string;
  url: string;
  description: string;
}

export interface CustomSearchResult {
  ok: boolean;
  query: string;
  hits: CustomSearchHit[];
  error?: string;
}

export interface CustomPreSearchInput {
  name?: string;
  phone?: string;
  website?: string;
}

export interface CustomPreSearchResult {
  searches: CustomSearchResult[];
}

// ── Internals ────────────────────────────────────────────────────────────────

const CUSTOM_SEARCH_ENDPOINT = "https://customsearch.googleapis.com/customsearch/v1";

interface CustomSearchApiItem {
  title?: string;
  link?: string;
  snippet?: string;
}

/** Single Google Programmable Search call. Same fail-soft contract as the
 *  Brave wrapper this replaced: errors come back as `{ ok: false, error }`
 *  so the pre-search bundle keeps going. */
export async function customWebSearch(query: string, count = 6): Promise<CustomSearchResult> {
  if (!config.GOOGLE_CUSTOM_SEARCH_API_KEY || !config.GOOGLE_CUSTOM_SEARCH_CX) {
    return {
      ok: false,
      query,
      hits: [],
      error: "GOOGLE_CUSTOM_SEARCH_API_KEY / GOOGLE_CUSTOM_SEARCH_CX not configured",
    };
  }
  // Custom Search API caps `num` at 10 per call.
  const num = Math.max(1, Math.min(10, count));
  const url =
    `${CUSTOM_SEARCH_ENDPOINT}?key=${encodeURIComponent(config.GOOGLE_CUSTOM_SEARCH_API_KEY)}` +
    `&cx=${encodeURIComponent(config.GOOGLE_CUSTOM_SEARCH_CX)}` +
    `&q=${encodeURIComponent(query)}` +
    `&num=${num}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        query,
        hits: [],
        error: `Custom Search ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as { items?: CustomSearchApiItem[] };
    const items = data?.items ?? [];
    const hits: CustomSearchHit[] = items.slice(0, num).map((r) => ({
      title: r.title ?? "",
      url: r.link ?? "",
      description: r.snippet ?? "",
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

/** Build the list of queries for a given lead. Phone-number first in three
 *  formats — Custom Search ranks well across punctuation but the surface
 *  text on Yelp/Facebook/Nextdoor pages varies, so probing each shape
 *  catches more long-tail listings. Then name (with the "business" hint)
 *  and the site: query when a website is present. No quoting — Google's
 *  matching is loose enough that quotes mostly hurt recall. */
export function buildCustomLeadQueries(input: CustomPreSearchInput): string[] {
  const queries: string[] = [];
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, "");
    let ten = digits;
    if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
    if (ten.length === 10) {
      queries.push(`${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`);
      queries.push(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
      queries.push(`+1${ten}`);
    } else {
      queries.push(input.phone);
    }
  }
  if (input.name) {
    queries.push(`${input.name} business`);
  }
  if (input.website) {
    queries.push(`site:${input.website.replace(/^https?:\/\//, "")}`);
  }
  return queries;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Run the pre-search bundle for a lead. Sequential to keep request
 *  volume modest against the Custom Search free tier (100 queries/day).
 *  Each query result — including failures and zero-hit responses — flows
 *  through to the skill so it can see what was tried, not just what
 *  worked.
 *
 *  Short-circuits to an empty bundle when the env vars are unset —
 *  Google has been gating the "search the entire web" toggle on new
 *  Programmable Search Engines, so deployments often skip Custom Search
 *  and rely on the Anthropic `web_search` tool instead. An empty bundle
 *  produces no Custom Search block in the user message, and the skill
 *  is already instructed to fall through to `web_search`. */
export async function preSearchLeadCustom(
  input: CustomPreSearchInput,
): Promise<CustomPreSearchResult> {
  if (!config.GOOGLE_CUSTOM_SEARCH_API_KEY || !config.GOOGLE_CUSTOM_SEARCH_CX) {
    return { searches: [] };
  }
  const queries = buildCustomLeadQueries(input);
  const searches: CustomSearchResult[] = [];
  for (const q of queries) {
    searches.push(await customWebSearch(q));
  }
  return { searches };
}

/** Render the pre-search result as a markdown block for the user message.
 *  Empty queries are still listed so the model knows what was tried. */
export function formatCustomPreSearch(result: CustomPreSearchResult): string {
  if (result.searches.length === 0) return "";
  const lines: string[] = [
    "## Google Custom Search results",
    "These are general web hits (Yelp, Nextdoor, Facebook, BBB, news, the business's own site) fetched before this prompt. The phone-number-matched listing wins; cross-reference with name/website if helpful. Treat these as supplementary context to the Google Places block above — Places phone-match is still authoritative when both agree.",
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
        const url = hit.url ? ` — ${hit.url}` : "";
        lines.push(`- **${hit.title}**${url}`);
        if (hit.description) lines.push(`  ${hit.description}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
