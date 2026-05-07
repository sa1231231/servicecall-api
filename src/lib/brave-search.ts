import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BraveSearchHit {
  title: string;
  url: string;
  description: string;
}

export interface BraveSearchResult {
  ok: boolean;
  query: string;
  hits: BraveSearchHit[];
  error?: string;
}

export interface PreSearchInput {
  name?: string;
  phone?: string;
  website?: string;
}

export interface PreSearchResult {
  searches: BraveSearchResult[];
}

// ── Internals ────────────────────────────────────────────────────────────────

const BRAVE_WEB_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Single Brave web-search call. Returns top `count` hits as a normalized
 *  shape. Errors don't throw — they're returned with `ok: false` so the
 *  caller (lead enrichment) can soldier on with whatever queries did
 *  succeed. */
export async function braveWebSearch(query: string, count = 6): Promise<BraveSearchResult> {
  if (!config.BRAVE_API_KEY) {
    return { ok: false, query, hits: [], error: "BRAVE_API_KEY not configured" };
  }
  const url = `${BRAVE_WEB_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": config.BRAVE_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        query,
        hits: [],
        error: `Brave ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const webResults = data?.web?.results ?? [];
    const hits: BraveSearchHit[] = webResults.slice(0, count).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      description: r.description ?? "",
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

/** Build the list of queries we run for a given lead. Phone number is
 *  the strongest identifier — try multiple formats since Brave's index
 *  is sensitive to punctuation. Then fall back to name + location, and
 *  the website if one was provided. */
export function buildLeadQueries(input: PreSearchInput): string[] {
  const queries: string[] = [];
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, "");
    let ten = digits;
    if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
    if (ten.length === 10) {
      // Three common formats — Brave's snippet matching is strict so
      // it's worth probing each.
      queries.push(`"${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}"`);
      queries.push(`"(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}"`);
      queries.push(`"+1${ten}"`);
    } else {
      queries.push(`"${input.phone}"`);
    }
  }
  if (input.name) {
    // Light disambiguation — pair the name with "business" so Brave
    // weights commercial listings over personal results.
    queries.push(`${input.name} business`);
  }
  if (input.website) {
    queries.push(`site:${input.website.replace(/^https?:\/\//, "")}`);
  }
  return queries;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Run the pre-search bundle for a lead. All queries run sequentially
 *  to respect Brave's free-tier rate limit (1 query/second). Returns
 *  every search's hits — including failures and zero-hit responses —
 *  so the skill can see what was tried, not just what worked. */
export async function preSearchLead(input: PreSearchInput): Promise<PreSearchResult> {
  const queries = buildLeadQueries(input);
  const searches: BraveSearchResult[] = [];
  for (const q of queries) {
    searches.push(await braveWebSearch(q));
  }
  return { searches };
}

/** Render the pre-search result as a markdown block to embed in the
 *  user message we send to the skill. Empty queries are still included
 *  so the model knows what was tried. */
export function formatPreSearch(result: PreSearchResult): string {
  if (result.searches.length === 0) return "";
  const lines: string[] = [
    "## Pre-search context (Brave Search results)",
    "These results were fetched before this prompt. Treat them as the primary source of truth for business identity. The phone-number-matched listing wins; cross-reference with name/website if helpful.",
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
