import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { preSearchLead, formatPreSearch, type PreSearchResult } from "./brave-search.js";
import {
  preSearchLeadPlaces,
  formatPlacesPreSearch,
  type PlacesPreSearchResult,
} from "./google-places.js";

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
 * Call the user's Claude skill (loaded from `skills/onboarding-to-config/`)
 * to enrich a raw lead into a business name + FAQ + suggested template.
 * Best-effort: any failure returns `{ ok: false }` with a human-readable
 * error so the caller can park the lead in `failed` status.
 */
export async function enrichLead(input: EnrichmentInput): Promise<EnrichmentResult> {
  // Pre-search runs on every call. Google Places (New) is the primary
  // identifier source — it's backed by Google Business Profile data,
  // which is where small service businesses actually live. Brave fills
  // out long-tail web context (BBB, Yelp, news, the business's own
  // site) that Places doesn't return. Run both in parallel.
  let preSearch: PreSearchResult = { searches: [] };
  let placesSearch: PlacesPreSearchResult = { searches: [] };
  try {
    [preSearch, placesSearch] = await Promise.all([
      preSearchLead(input),
      preSearchLeadPlaces(input),
    ]);
  } catch (err) {
    console.warn(
      `[enrich-lead] pre-search failed for ${input.name}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const userMessage = formatLeadAsUserMessage(input, preSearch, placesSearch);

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
    // No server-side tools — the skill consumes the Brave results
    // baked into the user message and emits the JSON directly. Cheaper,
    // faster, and the response is deterministic on a fixed pre-search.
    const result = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const rawResponse = extractText(result);
    const rawContentBlocks = summarizeContentBlocks(result);
    console.log(
      `[enrich-lead] ${input.name} — input ${userMessage.length}b, response ${rawResponse.length}b, places=${placesSearch.searches.length}, brave=${preSearch.searches.length}`,
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
 *  Includes Google Places + Brave pre-search results inline so the
 *  skill can read business facts off concrete listings instead of
 *  guessing. Places hits go first because they're authoritative. */
export function formatLeadAsUserMessage(
  input: EnrichmentInput,
  preSearch?: PreSearchResult,
  placesSearch?: PlacesPreSearchResult,
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
  if (preSearch && preSearch.searches.length > 0) {
    lines.push("", formatPreSearch(preSearch));
  }

  lines.push(
    "",
    "This is incoming lead-form data — there is NO transcript and the operator wants a starter config they can edit. Use the pre-search context above as the primary source of truth: **Google Places hits are authoritative** — if Places returned a business for the phone number, that's the business, full stop. Use the Brave block for supplementary context (hours, services, summaries). The lead-form `name` is often the owner or a partial business name; trust the Places-derived name when they conflict. Reserve DRAFT for when both Places AND Brave came back empty across every query.",
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

/** Parse the skill's JSON envelope. Tolerates leading/trailing whitespace,
 *  accidental ```json fences, and either snake_case or camelCase field
 *  names — the skill emits `businessName` but we accept `business_name`
 *  too for symmetry with other internal call sites. The raw model text
 *  and the user message we sent are returned on every result so the UI
 *  can render an AI Feed regardless of parse outcome. */
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
  try {
    obj = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      error:
        "could not parse JSON from skill response: " +
        (err instanceof Error ? err.message : String(err)),
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
