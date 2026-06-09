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

export interface BravePreSearchInput {
  name?: string;
  phone?: string;
  website?: string;
}

export interface BravePreSearchResult {
  searches: BraveSearchResult[];
}

// ── Internals ────────────────────────────────────────────────────────────────

const BRAVE_WEB_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

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

export function buildBraveLeadQueries(input: BravePreSearchInput): string[] {
  const queries: string[] = [];
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, "");
    let ten = digits;
    if (digits.length === 11 && digits[0] === "1") ten = digits.slice(1);
    if (ten.length === 10) {
      // Brave's snippet matching is strict, so probe each common phone
      // surface form. Quoted to keep the matcher tight on exact strings.
      queries.push(`"${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}"`);
      queries.push(`"(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}"`);
      queries.push(`"+1${ten}"`);
    } else {
      queries.push(`"${input.phone}"`);
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

export async function preSearchLeadBrave(
  input: BravePreSearchInput,
): Promise<BravePreSearchResult> {
  if (!config.BRAVE_API_KEY) {
    return { searches: [] };
  }
  const queries = buildBraveLeadQueries(input);
  const searches: BraveSearchResult[] = [];
  // Sequential — Brave's free tier caps at 1 query/second.
  for (const q of queries) {
    searches.push(await braveWebSearch(q));
  }
  return { searches };
}

export function formatBravePreSearch(result: BravePreSearchResult): string {
  if (result.searches.length === 0) return "";
  const lines: string[] = [
    "## Brave Search results",
    "Long-tail web hits (Nextdoor, Facebook, Yelp, BBB, the business's own site) from Brave's index. Treat as supplementary to Places above — useful when Places is thin or for filling in concrete FAQ facts (hours, services, service area). Yelp pages still get indexed by Brave; we just no longer have a dedicated Yelp pre-search.",
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
