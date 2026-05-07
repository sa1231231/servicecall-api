import { describe, it, expect } from "vitest";
import { parseEnrichmentResponse, extractText } from "../enrich-lead.js";

describe("parseEnrichmentResponse", () => {
  it("parses a clean JSON envelope", () => {
    const r = parseEnrichmentResponse(
      JSON.stringify({ business_name: "Acme", faqKnowledgeBase: "Q?\nA." }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business_name).toBe("Acme");
      expect(r.faqKnowledgeBase).toBe("Q?\nA.");
      expect(r.extra).toEqual({});
    }
  });

  it("strips a markdown ```json fence the model added", () => {
    const r = parseEnrichmentResponse(
      "```json\n" + JSON.stringify({ business_name: "X", faqKnowledgeBase: "y" }) + "\n```",
    );
    expect(r.ok).toBe(true);
  });

  it("strips a plain ``` fence", () => {
    const r = parseEnrichmentResponse(
      "```\n" + JSON.stringify({ business_name: "X", faqKnowledgeBase: "y" }) + "\n```",
    );
    expect(r.ok).toBe(true);
  });

  it("captures extra keys into the .extra bag", () => {
    const r = parseEnrichmentResponse(
      JSON.stringify({
        business_name: "Acme",
        faqKnowledgeBase: "Q?",
        business_type: "plumbing",
        services: ["leak", "drain"],
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.extra).toEqual({ business_type: "plumbing", services: ["leak", "drain"] });
    }
  });

  it("fails when JSON is malformed", () => {
    const r = parseEnrichmentResponse("not json at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/parse/i);
  });

  it("fails when the JSON is empty/whitespace", () => {
    const r = parseEnrichmentResponse("   ");
    expect(r.ok).toBe(false);
  });

  it("fails when both required fields are missing", () => {
    const r = parseEnrichmentResponse(JSON.stringify({ business_type: "plumbing" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing/i);
  });

  it("succeeds with only business_name (FAQ may legitimately be empty)", () => {
    const r = parseEnrichmentResponse(
      JSON.stringify({ business_name: "Acme", faqKnowledgeBase: "" }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("extractText", () => {
  it("concatenates text blocks from a Messages API response", () => {
    const result = {
      content: [
        { type: "text", text: "First " },
        { type: "tool_use", input: { x: 1 } }, // ignored
        { type: "text", text: "Second" },
      ],
    };
    expect(extractText(result)).toBe("First \nSecond");
  });

  it("returns empty string for null / non-array shapes", () => {
    expect(extractText(null)).toBe("");
    expect(extractText({})).toBe("");
    expect(extractText({ content: "string-not-array" })).toBe("");
  });
});
