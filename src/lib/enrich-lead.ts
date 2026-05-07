import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EnrichmentInput {
  name: string;
  phone?: string;
  website?: string;
  notes?: string;
}

export interface EnrichmentSuccess {
  ok: true;
  business_name: string;
  faqKnowledgeBase: string;
  /** Skill output: a draft/template name the operator should pre-select. */
  templateName?: string;
  /** Pass-through bag for any keys the skill returns beyond the known three. */
  extra: Record<string, unknown>;
}

export interface EnrichmentFailure {
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
  if (!config.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "Anthropic enrichment not configured — set ANTHROPIC_API_KEY.",
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
    };
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const userText = formatLeadAsUserMessage(input);

  try {
    const result = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: buildSystemPrompt(skill),
      messages: [{ role: "user", content: userText }],
    });

    const text = extractText(result);
    return parseEnrichmentResponse(text);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Hand-shaped user message that matches the skill's trigger phrasing. */
export function formatLeadAsUserMessage(input: EnrichmentInput): string {
  const lines = [
    "Onboard this client and produce a Service Call Saver config.",
    "",
    "Lead info:",
    `- Name / Business: ${input.name}`,
  ];
  if (input.phone) lines.push(`- Phone: ${input.phone}`);
  if (input.website) lines.push(`- Website: ${input.website}`);
  if (input.notes) lines.push(`- Notes: ${input.notes}`);
  lines.push(
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

/** Parse the skill's JSON envelope. Tolerates leading/trailing whitespace,
 *  accidental ```json fences, and either snake_case or camelCase field
 *  names — the skill emits `businessName` but we accept `business_name`
 *  too for symmetry with other internal call sites. */
export function parseEnrichmentResponse(text: string): EnrichmentResult {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  if (!stripped) {
    return { ok: false, error: "skill response was empty" };
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
    };
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "skill response was not a JSON object" };
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
  return { ok: true, business_name, faqKnowledgeBase, templateName, extra };
}

function pickString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}
