import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  preSearchLeadBrave,
  formatBravePreSearch,
  type BravePreSearchResult,
} from "./brave-search.js";
import {
  preSearchLeadPlaces,
  formatPlacesPreSearch,
  type PlacesPreSearchResult,
} from "./google-places.js";
import {
  lookupCallerName,
  formatCallerName,
  type CallerNameResult,
} from "./twilio-caller-name.js";
import {
  yelpPhoneSearch,
  formatYelpPhoneSearch,
  type YelpPhoneSearchResult,
} from "./yelp-search.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EnrichmentInput {
  name: string;
  phone?: string;
  website?: string;
  notes?: string;
  /** Self-reported industry from a structured form question (e.g. Meta
   *  Lead Ads "which best fits the business you have?"). Surfaced to the
   *  skill as a disambiguation hint — see the SKILL.md section "Self-
   *  reported business type". */
  business_type?: string;
}

/** Conversation transcript captured for every call. Surfaced in the
 *  dashboard's AI Feed panel so the operator can see exactly what was
 *  sent and what came back, regardless of parse outcome. */
export interface EnrichmentTranscript {
  /** The system prompt the model received — SKILL.md body + each
   *  reference file concatenated by `buildSystemPrompt`. Persisted with
   *  the lead so refinement isn't ambiguous if SKILL.md changes later. */
  systemPrompt: string;
  /** The user message we POSTed (output of `formatLeadAsUserMessage`). */
  userMessage: string;
  /** The text content of the model's reply (concatenated text blocks). */
  rawResponse: string;
  /** Compact summary of every content block the API returned, so we can
   *  see tool_use / tool_result activity (e.g. web_search calls) in the
   *  AI Feed — not just the final text. JSON-stringified for storage. */
  rawContentBlocks: string;
}

export interface EnrichmentSuccess extends EnrichmentTranscript {
  ok: true;
  business_name: string;
  faqKnowledgeBase: string;
  /** Skill output: a draft/template name the operator should pre-select. */
  templateName?: string;
  /** Pass-through bag for any keys the skill returns beyond the known three. */
  extra: Record<string, unknown>;
}

export interface EnrichmentFailure extends EnrichmentTranscript {
  ok: false;
  error: string;
}

export type EnrichmentResult = EnrichmentSuccess | EnrichmentFailure;

// ── Skill loader (source of truth = the repo) ───────────────────────────────
//
// The skill lives at `skills/<name>/`. SKILL.md (with frontmatter) is the
// primary instruction; anything under `skills/<name>/references/*.md` is
// concatenated as additional context. Read on every call so editing the
// skill in-repo doesn't require a server restart — the next lead pulls
// the new content instantly.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist sits at <repo>/dist/lib/enrich-lead.js, src at <repo>/src/lib/...
// The skills directory is two levels up from either layout.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SKILLS_DIR_DIST = path.join(REPO_ROOT, "skills");
const SKILLS_DIR_SRC = path.join(REPO_ROOT, "..", "skills");

function findSkillsDir(): string {
  // Prefer the colocated path; fall back to the parent for ts-running tests.
  if (fs.existsSync(SKILLS_DIR_DIST)) return SKILLS_DIR_DIST;
  if (fs.existsSync(SKILLS_DIR_SRC)) return SKILLS_DIR_SRC;
  return SKILLS_DIR_DIST;
}

export interface LoadedSkill {
  name: string;
  body: string;
  referenceFiles: Array<{ path: string; content: string }>;
}

export function loadSkill(name: string): LoadedSkill {
  const dir = path.join(findSkillsDir(), name);
  const skillMdPath = path.join(dir, "SKILL.md");
  const raw = fs.readFileSync(skillMdPath, "utf8");
  const body = stripFrontmatter(raw);

  const referenceFiles: LoadedSkill["referenceFiles"] = [];
  const refDir = path.join(dir, "references");
  if (fs.existsSync(refDir) && fs.statSync(refDir).isDirectory()) {
    for (const file of fs.readdirSync(refDir)) {
      if (file.startsWith(".")) continue;
      const full = path.join(refDir, file);
      if (!fs.statSync(full).isFile()) continue;
      referenceFiles.push({
        path: `references/${file}`,
        content: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return { name, body, referenceFiles };
}

function stripFrontmatter(md: string): string {
  // Front matter is delimited by leading `---` on its own line and a closing
  // `---`. If the file doesn't start with it, return as-is.
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return md;
  return md.slice(end + 4).replace(/^\s*\n/, "");
}

/** Build the system prompt by stitching SKILL.md + each reference file. */
export function buildSystemPrompt(skill: LoadedSkill): string {
  const sections = [skill.body];
  for (const ref of skill.referenceFiles) {
    sections.push(
      `\n\n---\n\n# ${ref.path}\n\n${ref.content}`,
    );
  }
  return sections.join("");
}

// ── Public API ──────────────────────────────────────────────────────────────

const SKILL_NAME = "onboarding-to-config";

/**
 * Transient Anthropic API failures worth retrying: rate limits (429),
 * "overloaded" (529), and any 5xx. Everything else (4xx misuse, timeouts)
 * is non-transient — retrying won't help. The SDK error carries a numeric
 * `status`; we fall back to matching the message for shapes without it.
 */
export function isTransientAnthropicError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number") {
    return status === 429 || status >= 500;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /(^|\D)(429|5\d\d)(\D|$)|overloaded/i.test(msg);
}

/**
 * Runs an Anthropic call, retrying transient overload/rate-limit failures
 * with backoff. The SDK retries fast blips internally; this rides out a
 * *sustained* overload spike (e.g. a 529 storm) so a transient Anthropic
 * outage doesn't permanently fail an otherwise-fine lead. 3 attempts total,
 * 30s then 60s backoff.
 */
export async function withAnthropicRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  backoffMs = (attempt: number) => attempt * 30_000,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientAnthropicError(err)) throw err;
      const waitMs = backoffMs(attempt);
      const status = (err as { status?: number } | null)?.status ?? "?";
      console.warn(
        `[enrich-lead] Anthropic transient error (status ${status}), ` +
          `attempt ${attempt}/${maxAttempts} — retrying in ${waitMs / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/**
 * Call the user's Claude skill (loaded from `skills/onboarding-to-config/`)
 * to enrich a raw lead into a business name + FAQ + suggested template.
 * Best-effort: any failure returns `{ ok: false }` with a human-readable
 * error so the caller can park the lead in `failed` status.
 */
export async function enrichLead(input: EnrichmentInput): Promise<EnrichmentResult> {
  // Pre-search runs on every call. Four parallel channels — each has a
  // different sweet spot, so we hit them all and let the model pick the
  // strongest signal:
  //
  //   1. Google Places (New)     — phone-match against Google Business
  //                                 Profile. Authoritative when it hits.
  //   2. Yelp Fusion              — phone-match against Yelp listings.
  //                                 Strong on B2B service businesses
  //                                 with thin GBP presence.
  //   3. Twilio caller-name       — carrier CNAM lookup. Sometimes the
  //                                 business name; otherwise the owner's
  //                                 personal name (still useful for
  //                                 cross-referencing the lead form).
  //   4. Brave Search             — long-tail web hits (Nextdoor, Facebook,
  //                                 Yelp, BBB) for businesses that don't
  //                                 surface in Places/Yelp. Disabled when
  //                                 BRAVE_API_KEY unset.
  //
  // If every channel misses, the skill falls back on its `web_search`
  // tool — see SKILL.md. Twilio + Yelp gate on `input.phone` so they
  // don't fire on phone-less leads.
  let placesSearch: PlacesPreSearchResult = { searches: [] };
  let braveSearch: BravePreSearchResult = { searches: [] };
  let callerName: CallerNameResult | undefined;
  let yelpSearch: YelpPhoneSearchResult | undefined;
  try {
    [placesSearch, braveSearch, callerName, yelpSearch] = await Promise.all([
      preSearchLeadPlaces(input),
      preSearchLeadBrave(input),
      input.phone ? lookupCallerName(input.phone) : Promise.resolve(undefined),
      input.phone ? yelpPhoneSearch(input.phone) : Promise.resolve(undefined),
    ]);
  } catch (err) {
    console.warn(
      `[enrich-lead] pre-search failed for ${input.name}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const userMessage = formatLeadAsUserMessage(
    input,
    placesSearch,
    callerName,
    yelpSearch,
    braveSearch,
  );

  if (!config.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "Anthropic enrichment not configured — set ANTHROPIC_API_KEY.",
      systemPrompt: "",
      userMessage,
      rawResponse: "",
      rawContentBlocks: "",
    };
  }

  let skill: LoadedSkill;
  try {
    skill = loadSkill(SKILL_NAME);
  } catch (err) {
    return {
      ok: false,
      error:
        "Could not load skill from disk: " +
        (err instanceof Error ? err.message : String(err)),
      systemPrompt: "",
      userMessage,
      rawResponse: "",
      rawContentBlocks: "",
    };
  }

  const systemPrompt = buildSystemPrompt(skill);
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  try {
    // Server-side `web_search` and `web_fetch` tools are exposed so the
    // model has a real fallback when both pre-searches miss. Small
    // service businesses on Nextdoor/Facebook frequently aren't in
    // Places and don't surface from a single Custom Search query — the
    // skill is instructed to call `web_search` with multiple phone
    // formats before resorting to DRAFT, then `web_fetch` the resolved
    // listing/website to fill the FAQ. `max_uses` caps blast radius.
    // Tool blocks are captured by `summarizeContentBlocks` so the AI
    // Feed shows every search and fetch the model ran.
    // 120s ceiling: web_search (max 4) + web_fetch (max 3) plus model
    // thinking time should land in 30–60s typical, 90s worst case. The
    // ceiling guarantees we *fail* the lead instead of leaving it stuck
    // in "enriching" forever if the SDK hangs or the model gets into a
    // tool-calling loop. The route's catch path will then patch the
    // lead to status="failed" with the timeout error so the operator
    // can re-enrich.
    const result = await withAnthropicRetry(() =>
      client.messages.create(
        {
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          tools: [
            // 8 (not 4) because the model spends 2–3 web_search calls
            // exploring query variants before landing on the bare-phone
            // query that surfaces Nextdoor/Facebook long-tail listings.
            // With code_execution wrapping each search, a tight budget
            // hits "Server tool use limit exceeded" before the obvious
            // query gets tried. 8 is still ~$0.08/lead worst case.
            { type: "web_search_20260209", name: "web_search", max_uses: 8 },
            { type: "web_fetch_20260309", name: "web_fetch", max_uses: 3 },
          ],
        },
        { timeout: 120_000 },
      ),
    );

    const rawResponse = extractText(result);
    const rawContentBlocks = summarizeContentBlocks(result);
    const yelpHits = yelpSearch?.ok ? yelpSearch.hits.length : "n/a";
    const cnam = callerName?.ok ? callerName.lookup?.callerName ?? "(empty)" : "n/a";
    console.log(
      `[enrich-lead] ${input.name} — input ${userMessage.length}b, response ${rawResponse.length}b, places=${placesSearch.searches.length}, yelp=${yelpHits}, cnam=${cnam}, brave=${braveSearch.searches.length}`,
    );
    return parseEnrichmentResponse(rawResponse, userMessage, systemPrompt, rawContentBlocks);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      systemPrompt,
      userMessage,
      rawResponse: "",
      rawContentBlocks: "",
    };
  }
}

/** Hand-shaped user message that matches the skill's trigger phrasing.
 *  Bakes in every pre-search channel that returned data: Places, Yelp,
 *  Twilio CNAM, Brave. Order in the prompt matches strength of signal —
 *  Places first (authoritative when it hits), then Yelp (also strong
 *  for B2B services), then CNAM (sometimes the business name), then
 *  Brave (broadest long-tail web context, weakest individual hits). */
export function formatLeadAsUserMessage(
  input: EnrichmentInput,
  placesSearch?: PlacesPreSearchResult,
  callerName?: CallerNameResult,
  yelpSearch?: YelpPhoneSearchResult,
  braveSearch?: BravePreSearchResult,
): string {
  const lines = [
    "Onboard this client and produce a Service Call Saver config.",
    "",
    "## Lead info",
    `- Name / Business: ${input.name}`,
  ];
  if (input.phone) lines.push(`- Phone: ${input.phone}`);
  if (input.website) lines.push(`- Website: ${input.website}`);
  if (input.business_type) lines.push(`- Self-reported business type: ${input.business_type}`);
  if (input.notes) lines.push(`- Notes: ${input.notes}`);

  if (placesSearch && placesSearch.searches.length > 0) {
    lines.push("", formatPlacesPreSearch(placesSearch));
  }
  if (yelpSearch) {
    lines.push("", formatYelpPhoneSearch(yelpSearch));
  }
  if (callerName) {
    lines.push("", formatCallerName(callerName));
  }
  if (braveSearch && braveSearch.searches.length > 0) {
    lines.push("", formatBravePreSearch(braveSearch));
  }

  lines.push(
    "",
    "This is incoming lead-form data — there is NO transcript and the operator wants a starter config they can edit. Use the pre-search context above as the primary source of truth, in this order of authority:",
    "1. **Google Places phone-match** — strongest signal; use the listing's name verbatim.",
    "2. **Yelp phone-match** — also strong for B2B service businesses; categories map directly to a template.",
    "3. **Twilio CNAM** — sometimes the registered business name, sometimes the owner's personal name. When the name looks like a person, treat it as identity-confirming for the lead, not as the business name.",
    "4. **Brave Search** — supplementary web context (hours, services, long-tail listings on Nextdoor / Facebook / BBB).",
    "",
    "The lead-form `name` is often the owner or a partial business name; trust Places/Yelp-derived names when they conflict. If all pre-search blocks are empty or inconclusive, **call `web_search`** with the phone number (multiple formats) before resorting to DRAFT. Once a business is resolved, **call `web_fetch`** on the strongest listing or website to extract concrete FAQ facts. Reserve DRAFT for when every pre-search channel AND web_search all came back empty.",
    "",
    "Return ONLY the JSON config (businessName, faqKnowledgeBase, templateName) — no prose, no markdown fencing.",
  );
  return lines.join("\n");
}

// ── Internals (exported for testing) ────────────────────────────────────────

export function extractText(result: unknown): string {
  const blocks = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** JSON-stringify every content block (text, tool_use, tool_result, etc.)
 *  with a length cap per block so we can spot whether web_search fired,
 *  what queries it ran, and what came back, without dumping the full
 *  result on every call. Stored verbatim on the lead for the AI Feed. */
export function summarizeContentBlocks(result: unknown): string {
  const blocks = (result as { content?: Array<Record<string, unknown>> })?.content;
  if (!Array.isArray(blocks)) return "[]";
  const compact = blocks.map((b) => {
    const out: Record<string, unknown> = { type: b.type };
    // Tool inputs (web_search query, etc.) are short and high-signal.
    if (b.input !== undefined) out.input = b.input;
    if (b.name !== undefined) out.name = b.name;
    // Tool results can be huge — truncate to keep the lead doc small.
    if (b.content !== undefined) {
      const c = b.content;
      const stringified = typeof c === "string" ? c : JSON.stringify(c);
      out.content = stringified.length > 1500 ? stringified.slice(0, 1500) + " …[truncated]" : stringified;
    }
    if (typeof b.text === "string") {
      out.text = b.text.length > 1500 ? b.text.slice(0, 1500) + " …[truncated]" : b.text;
    }
    return out;
  });
  return JSON.stringify(compact, null, 2);
}

/** Walk the text and return the substring of the first balanced `{...}`
 *  JSON object. Handles the common case where the model emits prose
 *  before a fenced or unfenced JSON block (e.g., "I have enough to build
 *  the config. Key facts: …\n```json\n{ ... }\n```"). String-aware so
 *  braces inside string literals don't throw the depth count off. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Parse the skill's JSON envelope. Tolerates leading/trailing whitespace,
 *  accidental ```json fences, prose wrapping (model adds an explanation
 *  before/after the JSON despite being told not to), and either snake_case
 *  or camelCase field names — the skill emits `businessName` but we
 *  accept `business_name` too for symmetry with other internal call sites.
 *  The raw model text and the user message we sent are returned on every
 *  result so the UI can render an AI Feed regardless of parse outcome. */
export function parseEnrichmentResponse(
  text: string,
  userMessage = "",
  systemPrompt = "",
  rawContentBlocks = "[]",
): EnrichmentResult {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!stripped) {
    return { ok: false, error: "skill response was empty", systemPrompt, userMessage, rawResponse: text, rawContentBlocks };
  }
  let obj: unknown;
  let firstErr: string | undefined;
  try {
    obj = JSON.parse(stripped);
  } catch (err) {
    firstErr = err instanceof Error ? err.message : String(err);
    // Fall back: extract the first balanced {...} block, in case the
    // model wrapped the JSON in prose / commentary / a fenced block we
    // didn't catch with the simple top/bottom strip above.
    const candidate = extractFirstJsonObject(stripped);
    if (candidate) {
      try {
        obj = JSON.parse(candidate);
      } catch (_) {
        // fall through; report firstErr below
      }
    }
  }
  if (obj === undefined) {
    return {
      ok: false,
      error:
        "could not parse JSON from skill response: " + (firstErr ?? "no JSON object found"),
      systemPrompt,
      userMessage,
      rawResponse: text,
      rawContentBlocks,
    };
  }
  if (!obj || typeof obj !== "object") {
    return {
      ok: false,
      error: "skill response was not a JSON object",
      systemPrompt,
      userMessage,
      rawResponse: text,
      rawContentBlocks,
    };
  }
  const o = obj as Record<string, unknown>;
  const business_name =
    pickString(o, "businessName") || pickString(o, "business_name");
  const faqKnowledgeBase =
    pickString(o, "faqKnowledgeBase") || pickString(o, "faq_knowledge_base");
  const templateName =
    pickString(o, "templateName") || pickString(o, "template_name") || undefined;
  if (!business_name && !faqKnowledgeBase) {
    return {
      ok: false,
      error: "skill response missing businessName and faqKnowledgeBase",
      systemPrompt,
      userMessage,
      rawResponse: text,
      rawContentBlocks,
    };
  }
  // Pass-through bag for keys we didn't extract above.
  const known = new Set([
    "businessName",
    "business_name",
    "faqKnowledgeBase",
    "faq_knowledge_base",
    "templateName",
    "template_name",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!known.has(k)) extra[k] = v;
  }
  return {
    ok: true,
    business_name,
    faqKnowledgeBase,
    templateName,
    extra,
    systemPrompt,
    userMessage,
    rawResponse: text,
    rawContentBlocks,
  };
}

function pickString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}
