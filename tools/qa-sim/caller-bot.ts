// LLM-driven "caller" used to drive synthetic chats against an agent.
// Each turn: given persona + scenario goal + conversation so far, generate
// the next thing the caller would say (or signal hang_up).
//
// Model choice: Claude Haiku 4.5. Caller turns are short (1–2 sentences);
// Haiku is fast + cheap and plenty smart for staying in persona. We cache
// the system prompt with the Anthropic prompt-cache so repeated turns
// in the same scenario only pay for the cumulative deltas, not the full
// persona+goal every time.
//
// Style mirror: `src/lib/transcript-analyzer.ts` for SDK usage; same
// JSON-shape-enforcement pattern.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../src/config.js";
import type { Persona } from "./personas.js";
import type { Scenario } from "./scenarios.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** One turn of a chat: who spoke + what they said. Mirrors the shape we
 *  feed the Anthropic SDK as alternating user/assistant messages. */
export interface TranscriptTurn {
  speaker: "agent" | "caller";
  text: string;
}

export interface CallerReply {
  /** What the caller says next. Empty when hang_up = true. */
  say: string;
  /** Caller hangs up — runner should stop the chat. */
  hang_up: boolean;
  /** Raw model output for debugging. */
  raw?: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generate the caller's next utterance given the conversation so far.
 *
 * The history is mapped onto the Anthropic message array with the caller's
 * own past lines as `role: "assistant"` (continuing their own thought) and
 * the agent's lines as `role: "user"` (the conversation partner). The model
 * is told via system prompt that it IS the caller, so this orientation
 * matches the persona's frame of reference.
 *
 * Returns `{ say: "", hang_up: true }` if the model decided the caller
 * would terminate the call, OR if the SDK call failed (the runner treats
 * hang_up as the end-of-scenario signal in both cases — a hung connection
 * is a valid scenario outcome).
 */
export async function generateCallerReply(args: {
  persona: Persona;
  scenario: Scenario;
  history: TranscriptTurn[];
}): Promise<CallerReply> {
  const { persona, scenario, history } = args;

  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set — required for caller-bot");
  }

  const systemPrompt = buildSystemPrompt(persona, scenario);
  const messages = buildMessages(history);

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  try {
    const result = await client.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        // Prompt caching: the persona + goal don't change turn-to-turn, so
        // marking the system prompt as ephemeral keeps cache hits high
        // across the ~15-30 turns of one scenario.
        system: [
          { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        messages,
      } as unknown as Anthropic.MessageCreateParamsNonStreaming,
      { timeout: 30_000 },
    );

    const text = extractFirstText(result);
    const parsed = parseCallerReply(text);
    return { ...parsed, raw: text };
  } catch (err) {
    // Network blip or rate limit → treat as caller hung up. The runner
    // will end the scenario gracefully; the report will note the early end.
    return {
      say: "",
      hang_up: true,
      raw: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt(persona: Persona, scenario: Scenario): string {
  return `${persona.systemPrompt}

## Your specific goal on this call

${scenario.goal}

## Response format

You MUST respond with a single JSON object on one line, no markdown, no prose around it:

{"say": "<your next utterance>", "hang_up": <true | false>}

Set hang_up to true ONLY when the call has reached a natural conclusion (agent said goodbye, your need is met, OR the agent is misbehaving badly enough that a real caller would hang up). Otherwise hang_up is false and you continue the conversation.

Keep \`say\` to ONE OR TWO short sentences. Real callers speak in short bursts.

Examples:
{"say": "Yeah, it's a Pete, gray cab.", "hang_up": false}
{"say": "Okay, thanks. Bye.", "hang_up": true}
{"say": "", "hang_up": true}`;
}

function buildMessages(history: TranscriptTurn[]): Anthropic.MessageParam[] {
  // Map history into role-flipped messages from the CALLER's POV.
  // Anthropic requires user/assistant strict alternation; if two consecutive
  // turns are from the same speaker we coalesce them with a blank line.
  const out: Anthropic.MessageParam[] = [];
  let lastRole: "user" | "assistant" | null = null;
  for (const turn of history) {
    const role: "user" | "assistant" = turn.speaker === "agent" ? "user" : "assistant";
    if (role === lastRole && out.length > 0) {
      const prev = out[out.length - 1];
      prev.content = `${prev.content}\n\n${turn.text}`;
    } else {
      out.push({ role, content: turn.text });
      lastRole = role;
    }
  }
  // Anthropic requires the conversation to end with a user turn (so the
  // assistant — the caller — can respond). If history ends with the caller
  // speaking, push a synthetic "(silence — your turn)" user prompt.
  if (out.length === 0 || out[out.length - 1].role === "assistant") {
    out.push({ role: "user", content: "(no response yet — what do you say next?)" });
  }
  return out;
}

function extractFirstText(result: Anthropic.Message): string {
  for (const block of result.content) {
    if ("text" in block) return (block as { text: string }).text;
  }
  return "";
}

/**
 * Parse `{"say": "...", "hang_up": false}` out of the model's response.
 *
 * Defensive: Haiku sometimes wraps in code fences or adds a stray newline
 * before the JSON. We try a direct JSON parse first, then a fallback that
 * extracts the first `{...}` block.
 */
export function parseCallerReply(raw: string): Pick<CallerReply, "say" | "hang_up"> {
  const trimmed = raw.trim();
  // Direct parse.
  try {
    const parsed = JSON.parse(trimmed);
    return normalize(parsed);
  } catch (_) { /* fall through to brace extraction */ }
  // Find the first `{` and matching `}` and try again.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return normalize(parsed);
    } catch (_) { /* fall through */ }
  }
  // Last resort: treat the whole response as a plain utterance.
  return { say: trimmed.slice(0, 500), hang_up: false };
}

function normalize(obj: unknown): Pick<CallerReply, "say" | "hang_up"> {
  if (!obj || typeof obj !== "object") return { say: "", hang_up: true };
  const o = obj as { say?: unknown; hang_up?: unknown };
  const say = typeof o.say === "string" ? o.say : "";
  const hang_up = o.hang_up === true || o.hang_up === "true";
  return { say, hang_up };
}
