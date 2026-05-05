import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CreateAgentBody } from "../agent-from-config.js";

const { mockCollection, mockGetDb } = vi.hoisted(() => {
  const find = vi.fn();
  const collection = vi.fn(() => ({ find }));
  return {
    mockCollection: { find },
    mockGetDb: vi.fn(() => ({ collection })),
  };
});

vi.mock("../db.js", () => ({
  getDb: () => mockGetDb(),
}));

const { slugify, loadTemplate, applyOverrides } = await import(
  "../agent-from-template.js"
);

// ── slugify ────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and hyphenates non-alphanumeric chars", () => {
    expect(slugify("Acme Plumbing Co")).toBe("acme-plumbing-co");
  });

  it("collapses runs of separators", () => {
    expect(slugify("Bob's HVAC & Heating!!")).toBe("bob-s-hvac-heating");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---Foo---")).toBe("foo");
    expect(slugify("&&Foo&&")).toBe("foo");
  });

  it("matches the UI's slug regex (public/index.html:1922)", () => {
    const ui = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    for (const s of ["Acme Co", "JA Fleet, LLC", "10-Star Plumbing!"]) {
      expect(slugify(s)).toBe(ui(s));
    }
  });
});

// ── applyOverrides ─────────────────────────────────────────────────────────

function makeBaseConfig(): CreateAgentBody {
  return {
    business: {
      businessName: "Original Co",
      faqKnowledgeBase: "old faq",
      introFinetuneExamples: [],
      closePrompt: "Original close",
    } as any,
    paths: [
      {
        name: "service",
        transitionCondition: "caller wants service",
        dataPoints: [{ variableName: "full_name", label: "Name", type: "string" } as any],
        end_mode: "callback",
      },
    ],
    client: {
      slug: "original-co",
      name: "Original Co",
      dispatch_text_numbers: ["+15550001111"],
      dispatch_email: ["dispatch@original.com"],
      summary_agent_id: null,
      shadow_mode: true,
    },
  };
}

describe("applyOverrides", () => {
  it("overrides businessName and faqKnowledgeBase", () => {
    const base = makeBaseConfig();
    const out = applyOverrides(base, {
      business: {
        businessName: "Acme Plumbing",
        faqKnowledgeBase: "## New FAQ",
      },
    });
    expect(out.business.businessName).toBe("Acme Plumbing");
    expect(out.business.faqKnowledgeBase).toBe("## New FAQ");
  });

  it("preserves other business fields verbatim", () => {
    const base = makeBaseConfig();
    const out = applyOverrides(base, {
      business: { businessName: "Acme", faqKnowledgeBase: "x" },
    });
    expect(out.business.closePrompt).toBe("Original close");
    expect(out.business.introFinetuneExamples).toEqual([]);
  });

  it("derives slug from businessName by default", () => {
    const base = makeBaseConfig();
    const out = applyOverrides(base, {
      business: { businessName: "Acme Plumbing Co", faqKnowledgeBase: "x" },
    });
    expect(out.client.slug).toBe("acme-plumbing-co");
  });

  it("uses explicit client.slug override", () => {
    const base = makeBaseConfig();
    const out = applyOverrides(base, {
      business: { businessName: "Acme", faqKnowledgeBase: "x" },
      client: { slug: "custom-slug" },
    });
    expect(out.client.slug).toBe("custom-slug");
  });

  it("preserves template's other client fields when not overridden", () => {
    const base = makeBaseConfig();
    const out = applyOverrides(base, {
      business: { businessName: "Acme", faqKnowledgeBase: "x" },
    });
    expect(out.client.dispatch_text_numbers).toEqual(["+15550001111"]);
    expect(out.client.dispatch_email).toEqual(["dispatch@original.com"]);
    expect(out.client.shadow_mode).toBe(true);
  });

  it("overrides client fields when provided", () => {
    const base = makeBaseConfig();
    const out = applyOverrides(base, {
      business: { businessName: "Acme", faqKnowledgeBase: "x" },
      client: {
        dispatch_text_numbers: ["+19998887777"],
        dispatch_call_number: "+15551234567",
      },
    });
    expect(out.client.dispatch_text_numbers).toEqual(["+19998887777"]);
    expect(out.client.dispatch_call_number).toBe("+15551234567");
    expect(out.client.dispatch_email).toEqual(["dispatch@original.com"]);
  });

  it("preserves paths from the template", () => {
    const base = makeBaseConfig();
    const out = applyOverrides(base, {
      business: { businessName: "Acme", faqKnowledgeBase: "x" },
    });
    expect(out.paths).toEqual(base.paths);
  });

  it("does not mutate the input config", () => {
    const base = makeBaseConfig();
    const snapshot = JSON.parse(JSON.stringify(base));
    applyOverrides(base, {
      business: { businessName: "Acme", faqKnowledgeBase: "x" },
      client: { slug: "acme" },
    });
    expect(base).toEqual(snapshot);
  });
});

// ── loadTemplate ───────────────────────────────────────────────────────────

describe("loadTemplate", () => {
  beforeEach(() => {
    mockCollection.find.mockReset();
  });

  function setupFindResult(doc: unknown) {
    const cursor = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      next: vi.fn().mockResolvedValue(doc),
    };
    mockCollection.find.mockReturnValue(cursor);
    return cursor;
  }

  it("returns the most recently updated template matching the name", async () => {
    const doc = { _id: "x", name: "plumber", type: "template", formData: {}, exportConfig: makeBaseConfig() };
    const cursor = setupFindResult(doc);

    const result = await loadTemplate("plumber");
    expect(result).toEqual(doc);
    expect(mockCollection.find).toHaveBeenCalledWith({ type: "template", name: "plumber" });
    expect(cursor.sort).toHaveBeenCalledWith({ updatedAt: -1 });
    expect(cursor.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no template matches", async () => {
    setupFindResult(null);
    const result = await loadTemplate("nonexistent");
    expect(result).toBeNull();
  });
});
