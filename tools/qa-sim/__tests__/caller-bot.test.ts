import { describe, it, expect } from "vitest";
import { parseCallerReply } from "../caller-bot.js";

// Caller-bot's pure parser. Network calls aren't tested here (those are
// covered implicitly by the live qa-sim run); we just lock in the JSON
// extraction so a stray code fence or trailing newline doesn't break the
// runner mid-scenario.

describe("parseCallerReply", () => {
  it("parses well-formed JSON", () => {
    expect(parseCallerReply('{"say": "hello", "hang_up": false}')).toEqual({
      say: "hello",
      hang_up: false,
    });
  });

  it("parses JSON wrapped in code fences", () => {
    const raw = '```json\n{"say": "got it", "hang_up": true}\n```';
    expect(parseCallerReply(raw)).toEqual({ say: "got it", hang_up: true });
  });

  it("treats hang_up: 'true' string as true (defensive)", () => {
    expect(parseCallerReply('{"say": "bye", "hang_up": "true"}')).toEqual({
      say: "bye",
      hang_up: true,
    });
  });

  it("falls back to plain text when no JSON present", () => {
    const raw = "Yeah, my truck is dead.";
    expect(parseCallerReply(raw)).toEqual({
      say: "Yeah, my truck is dead.",
      hang_up: false,
    });
  });

  it("extracts the first JSON-shaped block from chatty output", () => {
    const raw = 'Here is my reply:\n{"say": "okay", "hang_up": false}\nThanks.';
    expect(parseCallerReply(raw)).toEqual({ say: "okay", hang_up: false });
  });

  it("treats malformed JSON without crashing", () => {
    const raw = '{"say": "broken, "hang_up": false';
    const out = parseCallerReply(raw);
    // Either a fallback to plain text or an empty-hang. Either is acceptable;
    // the assertion is just that it didn't throw.
    expect(typeof out.say).toBe("string");
    expect(typeof out.hang_up).toBe("boolean");
  });
});
