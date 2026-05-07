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
  /** Pass-through bag for any keys the skill returns beyond the canonical
   *  two. v0 doesn't surface this in the UI but stores it for later use. */
  extra: Record<string, unknown>;
}

export interface EnrichmentFailure {
  ok: false;
  error: string;
}

export type EnrichmentResult = EnrichmentSuccess | EnrichmentFailure;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Call the user's Anthropic API Skill to enrich a raw lead into a
 * business name + FAQ. Best-effort: any failure returns `{ ok: false }`
 * with a human-readable error so the caller can park the lead in
 * `failed` status and let the operator hand-edit.
 */
export async function enrichLead(input: EnrichmentInput): Promise<EnrichmentResult> {
  if (!config.ANTHROPIC_API_KEY || !config.ANTHROPIC_SKILL_ID) {
    return {
      ok: false,
      error:
        "Anthropic enrichment not configured — set ANTHROPIC_API_KEY and ANTHROPIC_SKILL_ID.",
    };
  }

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const userText = JSON.stringify(input, null, 2);

  try {
    // Anthropic API Skills are referenced by id alongside the standard
    // Messages params. The SDK's static typings may not have caught up yet
    // depending on version, so we attach `skills` via the request-body
    // override and cast. If your account uses a different invocation
    // shape for Skills, adjust this single object.
    const result = await client.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content:
              "Lead to research and enrich:\n\n" +
              userText +
              "\n\nReturn ONLY a JSON object with exactly two keys: " +
              "`business_name` (string) and `faqKnowledgeBase` " +
              "(string of newline-separated Q/A entries). No prose, no " +
              "markdown fencing — just the JSON.",
          },
        ],
      } as any,
      {
        body: { skills: [{ id: config.ANTHROPIC_SKILL_ID }] },
      } as any,
    );

    const text = extractText(result);
    return parseEnrichmentResponse(text);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

/** Parse the skill's JSON envelope. Tolerant of leading/trailing whitespace
 *  and of accidental ```json fences the model sometimes adds despite
 *  instructions to emit raw JSON. */
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
  const business_name = typeof o.business_name === "string" ? o.business_name : "";
  const faqKnowledgeBase = typeof o.faqKnowledgeBase === "string" ? o.faqKnowledgeBase : "";
  if (!business_name && !faqKnowledgeBase) {
    return {
      ok: false,
      error: "skill response missing business_name and faqKnowledgeBase",
    };
  }
  const { business_name: _bn, faqKnowledgeBase: _fkb, ...extra } = o;
  return { ok: true, business_name, faqKnowledgeBase, extra };
}
