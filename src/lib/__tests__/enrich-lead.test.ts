import { describe, it, expect } from "vitest";
import {
  parseEnrichmentResponse,
  extractText,
  formatLeadAsUserMessage,
  buildSystemPrompt,
} from "../enrich-lead.js";

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

  it("accepts the skill's camelCase shape (businessName + templateName)", () => {
    const r = parseEnrichmentResponse(
      JSON.stringify({
        businessName: "Cairo HVAC",
        faqKnowledgeBase: "Q. Hours?\nA. 7-7 weekdays.",
        templateName: "hvac",
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business_name).toBe("Cairo HVAC");
      expect(r.faqKnowledgeBase).toBe("Q. Hours?\nA. 7-7 weekdays.");
      expect(r.templateName).toBe("hvac");
      expect(r.extra).toEqual({});
    }
  });

  it("templateName is omitted when the skill doesn't return one", () => {
    const r = parseEnrichmentResponse(
      JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "Q?" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.templateName).toBeUndefined();
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

describe("formatLeadAsUserMessage", () => {
  it("includes only the fields that are set", () => {
    const msg = formatLeadAsUserMessage({ name: "Acme" });
    expect(msg).toContain("Name / Business: Acme");
    expect(msg).not.toContain("Phone:");
    expect(msg).not.toContain("Website:");
    expect(msg).toContain("templateName");
  });

  it("includes phone, website, notes when provided", () => {
    const msg = formatLeadAsUserMessage({
      name: "Acme", phone: "+1", website: "x.com", notes: "vip",
    });
    expect(msg).toContain("Phone: +1");
    expect(msg).toContain("Website: x.com");
    expect(msg).toContain("Notes: vip");
  });
});

describe("buildSystemPrompt", () => {
  it("starts with the skill body and appends references with their relative paths", () => {
    const out = buildSystemPrompt({
      name: "x",
      body: "INSTRUCTION\nDo the thing.",
      referenceFiles: [
        { path: "references/a.md", content: "AAA" },
        { path: "references/b.md", content: "BBB" },
      ],
    });
    expect(out).toMatch(/^INSTRUCTION/);
    expect(out).toContain("# references/a.md\n\nAAA");
    expect(out).toContain("# references/b.md\n\nBBB");
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
