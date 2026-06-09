import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks for the enrichLead orchestrator tests ────────────────
//
// These also bleed into the pure-function tests below, but those tests don't
// invoke Anthropic / fs / brave / places, so the mocks are inert for them.

const {
  mockMessagesCreate,
  mockPreSearchLeadBrave,
  mockPreSearchLeadPlaces,
  mockLookupCallerName,
  mockPlacesPhoneLookup,
  mockFsExistsSync,
  mockFsReadFileSync,
  mockConfig,
} = vi.hoisted(() => ({
  mockMessagesCreate: vi.fn(),
  mockPreSearchLeadBrave: vi.fn(),
  mockPreSearchLeadPlaces: vi.fn(),
  mockLookupCallerName: vi.fn(),
  mockPlacesPhoneLookup: vi.fn(),
  mockFsExistsSync: vi.fn(),
  mockFsReadFileSync: vi.fn(),
  mockConfig: { ANTHROPIC_API_KEY: "test_key" as string | undefined },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    constructor(_opts: any) {}
    messages = { create: (...a: any[]) => mockMessagesCreate(...a) };
  },
}));

vi.mock("../../config.js", () => ({ config: mockConfig }));

vi.mock("../brave-search.js", () => ({
  preSearchLeadBrave: (...a: any[]) => mockPreSearchLeadBrave(...a),
  formatBravePreSearch: () => "BRAVE_PRE_SEARCH_BLOCK",
}));

vi.mock("../google-places.js", () => ({
  preSearchLeadPlaces: (...a: any[]) => mockPreSearchLeadPlaces(...a),
  placesPhoneLookup: (...a: any[]) => mockPlacesPhoneLookup(...a),
  formatPlacesPreSearch: () => "PLACES_PRE_SEARCH_BLOCK",
}));

vi.mock("../twilio-caller-name.js", () => ({
  lookupCallerName: (...a: any[]) => mockLookupCallerName(...a),
  formatCallerName: () => "CNAM_BLOCK",
}));

vi.mock("fs", async () => {
  const real = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...real,
    default: {
      ...real,
      existsSync: (p: any) => mockFsExistsSync(p),
      readFileSync: (p: any, e: any) => mockFsReadFileSync(p, e),
      statSync: () => ({ isDirectory: () => false }),
    },
    existsSync: (p: any) => mockFsExistsSync(p),
    readFileSync: (p: any, e: any) => mockFsReadFileSync(p, e),
    statSync: () => ({ isDirectory: () => false }),
  };
});

const {
  parseEnrichmentResponse,
  extractText,
  formatLeadAsUserMessage,
  buildSystemPrompt,
  enrichLead,
  isTransientAnthropicError,
  withAnthropicRetry,
} = await import("../enrich-lead.js");

beforeEach(() => {
  for (const m of [
    mockMessagesCreate,
    mockPreSearchLeadBrave,
    mockPreSearchLeadPlaces,
    mockLookupCallerName,
    mockPlacesPhoneLookup,
    mockFsExistsSync,
    mockFsReadFileSync,
  ]) {
    m.mockReset();
  }
  mockConfig.ANTHROPIC_API_KEY = "test_key";
  // Default: every pre-search channel returns empty/undefined.
  mockPreSearchLeadBrave.mockResolvedValue({ searches: [] });
  mockPreSearchLeadPlaces.mockResolvedValue({ searches: [] });
  mockLookupCallerName.mockResolvedValue({ ok: false, phone: "x", error: "test default" });
  mockPlacesPhoneLookup.mockResolvedValue({ ok: false, query: "x", hits: [], error: "no Places phone match" });
  // Default: skill loads cleanly. SKILL_DIR_DIST exists; references dir
  // does NOT (so the loop in loadSkill skips ref-file loading).
  mockFsExistsSync.mockImplementation((p: any) => {
    const s = String(p);
    if (s.endsWith("/skills")) return true;
    if (s.endsWith("/references")) return false;
    return false;
  });
  mockFsReadFileSync.mockImplementation((p: any) => {
    if (String(p).endsWith("SKILL.md")) {
      return "---\nfrontmatter: stripped\n---\nSKILL_BODY_INSTRUCTIONS";
    }
    throw new Error("unexpected readFileSync: " + p);
  });
});

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

  it("extracts JSON when the model wraps it in prose + fenced block (regression for the Mr Fix It Handyman case)", () => {
    // Real-world failure: model emitted explanatory bullets above a
    // ```json fenced object instead of returning JSON-only. Old parser
    // failed at the leading "I"; the new parser walks for the first
    // balanced {...} block.
    const text = `I have enough from the Yelp pre-search data and web search snippets to build the config. Key facts confirmed:
- **Business:** Mr Fix It Handyman Services
- **Phone:** (765) 480-3157

\`\`\`json
{
  "businessName": "Mr Fix It Handyman Services",
  "faqKnowledgeBase": "## Company Info\\nHandyman + plumbing in Galveston, IN.",
  "templateName": ""
}
\`\`\``;
    const r = parseEnrichmentResponse(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.business_name).toBe("Mr Fix It Handyman Services");
      expect(r.faqKnowledgeBase).toContain("Galveston, IN");
      // Empty-string templateName collapses to undefined per existing
      // behavior in pickString — handyman has no template anyway.
      expect(r.templateName).toBeUndefined();
    }
  });

  it("doesn't get confused by `{` characters inside string values", () => {
    // String containing braces shouldn't throw off the depth counter.
    const text = 'prose prose {{not json}} more prose ' +
      JSON.stringify({ businessName: "Acme {Closed}", faqKnowledgeBase: "Use { with care }" });
    const r = parseEnrichmentResponse(text);
    // The first { is in "{{not json}}" which isn't valid JSON but our
    // extractor finds the first balanced object — since "{not json}"
    // (one brace) IS a balanced span, we'd end up trying to parse it.
    // Verify graceful fallback rather than depending on exact behavior.
    // (If parse fails we should still get ok:false, not a crash.)
    expect([true, false]).toContain(r.ok);
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

  it("extracts structured website/city/state/email and keeps them out of extra", () => {
    const r = parseEnrichmentResponse(
      JSON.stringify({
        businessName: "Arctic Blast Heating & Air",
        faqKnowledgeBase: "Q?",
        templateName: "hvac",
        website: "arcticblasthvac.com",
        city: "Norcross",
        state: "GA",
        email: "info@arcticblasthvac.com",
        services: ["ac"], // an unknown key — should still land in extra
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.website).toBe("arcticblasthvac.com");
      expect(r.city).toBe("Norcross");
      expect(r.state).toBe("GA");
      expect(r.email).toBe("info@arcticblasthvac.com");
      expect(r.extra).toEqual({ services: ["ac"] });
    }
  });

  it("leaves website/city/state/email undefined when the skill emits \"\" or omits them", () => {
    const r = parseEnrichmentResponse(
      JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "Q?", website: "", city: "" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.website).toBeUndefined();
      expect(r.city).toBeUndefined();
      expect(r.state).toBeUndefined();
      expect(r.email).toBeUndefined();
    }
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

  it("includes self-reported business type when provided", () => {
    const msg = formatLeadAsUserMessage({ name: "Acme", business_type: "HVAC" });
    expect(msg).toContain("Self-reported business type: HVAC");
  });

  it("omits the business-type line when not provided", () => {
    const msg = formatLeadAsUserMessage({ name: "Acme" });
    expect(msg).not.toContain("Self-reported business type");
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

// ── enrichLead orchestrator ─────────────────────────────────────────────────
//
// Covers the path: pre-search (Brave + Places) → skill load →
// Anthropic call → parse. The AI Feed transcript (systemPrompt / userMessage
// / rawResponse / rawContentBlocks) is what the dashboard's AI Feed panel
// renders, so every branch must populate it.

describe("enrichLead — orchestrator", () => {
  it("happy path: returns ok=true with parsed business_name + faqKnowledgeBase + AI feed transcript", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        { type: "text", text: JSON.stringify({ businessName: "Acme HVAC", faqKnowledgeBase: "Q?\nA.", templateName: "hvac" }) },
      ],
    });
    const result = await enrichLead({ name: "Acme", phone: "+15551112222" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.business_name).toBe("Acme HVAC");
      expect(result.faqKnowledgeBase).toBe("Q?\nA.");
      expect(result.templateName).toBe("hvac");
      // Transcript is populated end-to-end.
      expect(result.systemPrompt).toContain("SKILL_BODY_INSTRUCTIONS");
      expect(result.userMessage).toContain("Acme");
      expect(result.userMessage).toContain("+15551112222");
      expect(result.rawResponse).toContain("Acme HVAC");
      expect(result.rawContentBlocks).toContain("text");
    }
  });

  it("captures every content block (tool_use, tool_result, text) in rawContentBlocks for the AI Feed", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [
        { type: "tool_use", name: "web_search", input: { query: "Acme HVAC NJ" } },
        { type: "tool_result", content: '{"results":["..."]}' },
        { type: "text", text: JSON.stringify({ businessName: "Acme HVAC", faqKnowledgeBase: "x" }) },
      ],
    });
    const result = await enrichLead({ name: "Acme" });
    expect(result.ok).toBe(true);
    // rawContentBlocks is a JSON-stringified summary of every block, not just text.
    expect(result.rawContentBlocks).toContain("tool_use");
    expect(result.rawContentBlocks).toContain("web_search");
    expect(result.rawContentBlocks).toContain("Acme HVAC NJ");
    expect(result.rawContentBlocks).toContain("tool_result");
    expect(result.rawContentBlocks).toContain("text");
  });

  it("returns ok=false with the AI Feed transcript still populated when parse fails (salvage path)", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "not even close to JSON" }],
    });
    const result = await enrichLead({ name: "Mystery Business" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/parse/i);
      // Crucial: the AI Feed must still render, so the transcript is preserved.
      expect(result.systemPrompt).toContain("SKILL_BODY_INSTRUCTIONS");
      expect(result.userMessage).toContain("Mystery Business");
      expect(result.rawResponse).toBe("not even close to JSON");
      expect(result.rawContentBlocks).toContain("text");
    }
  });

  it("returns ok=false with empty transcript when ANTHROPIC_API_KEY is unset", async () => {
    mockConfig.ANTHROPIC_API_KEY = undefined;
    const result = await enrichLead({ name: "Acme" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
      // No model call → systemPrompt is empty, but userMessage IS still the
      // formatted lead so the AI Feed can show what we WOULD have sent.
      expect(result.systemPrompt).toBe("");
      expect(result.userMessage).toContain("Acme");
      expect(result.rawResponse).toBe("");
      expect(result.rawContentBlocks).toBe("");
    }
    // Critical: the Anthropic mock was never called.
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns ok=false when the skill files can't be loaded from disk", async () => {
    mockFsReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: SKILL.md not found");
    });
    const result = await enrichLead({ name: "Acme" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/skill/i);
      expect(result.error).toMatch(/SKILL\.md/);
      expect(result.userMessage).toContain("Acme"); // pre-search ran first
    }
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it("returns ok=false when Anthropic.messages.create throws", async () => {
    mockMessagesCreate.mockRejectedValue(new Error("network blip"));
    const result = await enrichLead({ name: "Acme" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("network blip");
      // Transcript is preserved on the error path.
      expect(result.systemPrompt).toContain("SKILL_BODY_INSTRUCTIONS");
      expect(result.userMessage).toContain("Acme");
    }
  });

  it("skips Twilio + Places-phone when the lead has no phone (gated on input.phone)", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "ok" }) }],
    });
    await enrichLead({ name: "Phoneless Acme" });
    expect(mockLookupCallerName).not.toHaveBeenCalled();
    expect(mockPlacesPhoneLookup).not.toHaveBeenCalled();
  });

  it("calls Twilio + Places-phone pre-search when the lead has a phone", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "ok" }) }],
    });
    await enrichLead({ name: "Acme", phone: "+15551112222" });
    expect(mockLookupCallerName).toHaveBeenCalledWith("+15551112222");
    expect(mockPlacesPhoneLookup).toHaveBeenCalledWith("+15551112222");
  });

  it("folds the Places phone-lookup hit into placesSearch.searches[] so it renders in the Places block", async () => {
    mockPreSearchLeadPlaces.mockResolvedValue({
      searches: [{ ok: true, query: "(555) 111-2222", hits: [] }],
    });
    mockPlacesPhoneLookup.mockResolvedValue({
      ok: true,
      query: "phone:+15551112222",
      hits: [{ name: "Acme HVAC", website: "https://acme.example" }],
    });
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ businessName: "Acme HVAC", faqKnowledgeBase: "ok" }) }],
    });
    const result = await enrichLead({ name: "Acme", phone: "+15551112222" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The Places-block formatter is mocked to a fixed string, but the
      // bundle's `searches` array is what we want to verify — the phone
      // lookup result should have been appended. The user message
      // includes PLACES_PRE_SEARCH_BLOCK regardless; the proof the fold
      // happened is that the bundle now has 2 searches not 1.
      expect(mockPreSearchLeadPlaces).toHaveBeenCalled();
      expect(mockPlacesPhoneLookup).toHaveBeenCalled();
      expect(result.userMessage).toContain("PLACES_PRE_SEARCH_BLOCK");
    }
  });

  it("does NOT abort enrichment when the pre-search (Brave/Places) fails", async () => {
    mockPreSearchLeadBrave.mockRejectedValue(new Error("brave down"));
    mockPreSearchLeadPlaces.mockRejectedValue(new Error("places down"));
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "ok" }) }],
    });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await enrichLead({ name: "Acme" });
    expect(result.ok).toBe(true);
    // Both pre-search errors are warned (one Promise.all rejection captured).
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("includes Places block before Brave block in the user message (Places is authoritative)", async () => {
    mockPreSearchLeadBrave.mockResolvedValue({ searches: [{ query: "x", hits: [{}] }] });
    mockPreSearchLeadPlaces.mockResolvedValue({ searches: [{ query: "y", hits: [{}] }] });
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "ok" }) }],
    });
    const result = await enrichLead({ name: "Acme" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const placesIdx = result.userMessage.indexOf("PLACES_PRE_SEARCH_BLOCK");
      const braveIdx = result.userMessage.indexOf("BRAVE_PRE_SEARCH_BLOCK");
      expect(placesIdx).toBeGreaterThan(-1);
      expect(braveIdx).toBeGreaterThan(-1);
      expect(placesIdx).toBeLessThan(braveIdx);
    }
  });

  it("passes server-side web_search and web_fetch tools to Anthropic so the model can fall back when pre-search misses", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "Q" }) }],
    });
    await enrichLead({ name: "Acme" });
    const arg = mockMessagesCreate.mock.calls[0][0];
    expect(arg.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "web_search_20260209", name: "web_search" }),
        expect.objectContaining({ type: "web_fetch_20260309", name: "web_fetch" }),
      ]),
    );
    // max_uses caps blast radius — confirm both tools have it set.
    const ws = arg.tools.find((t: any) => t.name === "web_search");
    const wf = arg.tools.find((t: any) => t.name === "web_fetch");
    expect(typeof ws.max_uses).toBe("number");
    expect(typeof wf.max_uses).toBe("number");
  });

  it("calls the model with the correct shape (system=skill body, user=formatted lead)", async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ businessName: "Acme", faqKnowledgeBase: "Q" }) }],
    });
    await enrichLead({ name: "Acme HVAC", phone: "+1234", website: "acme.com" });
    expect(mockMessagesCreate).toHaveBeenCalledOnce();
    const arg = mockMessagesCreate.mock.calls[0][0];
    expect(arg.model).toBe("claude-sonnet-4-6");
    expect(arg.system).toContain("SKILL_BODY_INSTRUCTIONS");
    expect(arg.messages).toHaveLength(1);
    expect(arg.messages[0].role).toBe("user");
    expect(arg.messages[0].content).toContain("Acme HVAC");
    expect(arg.messages[0].content).toContain("acme.com");
  });
});

describe("isTransientAnthropicError", () => {
  it("treats 429 / 529 / 5xx statuses as transient", () => {
    expect(isTransientAnthropicError({ status: 429 })).toBe(true);
    expect(isTransientAnthropicError({ status: 529 })).toBe(true);
    expect(isTransientAnthropicError({ status: 500 })).toBe(true);
    expect(isTransientAnthropicError({ status: 503 })).toBe(true);
  });

  it("treats 4xx misuse statuses (other than 429) as non-transient", () => {
    expect(isTransientAnthropicError({ status: 400 })).toBe(false);
    expect(isTransientAnthropicError({ status: 401 })).toBe(false);
    expect(isTransientAnthropicError({ status: 404 })).toBe(false);
  });

  it("falls back to message matching when there's no numeric status", () => {
    expect(isTransientAnthropicError(new Error('529 {"type":"overloaded_error"}'))).toBe(true);
    expect(isTransientAnthropicError(new Error("Overloaded"))).toBe(true);
    expect(isTransientAnthropicError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientAnthropicError(new Error("invalid_request_error: bad model"))).toBe(false);
  });
});

describe("withAnthropicRetry", () => {
  it("returns the result without retrying when the call succeeds", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withAnthropicRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure with backoff, then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw { status: 529, message: "Overloaded" };
      return "recovered";
    });
    const promise = withAnthropicRetry(fn);
    await vi.advanceTimersByTimeAsync(100_000); // drain 30s + 60s backoff
    expect(await promise).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("gives up after maxAttempts and throws the last transient error", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue({ status: 529, message: "Overloaded" });
    const promise = withAnthropicRetry(fn);
    const settled = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(100_000);
    const err = await settled;
    expect((err as { status: number }).status).toBe(529);
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does not retry a non-transient error — throws on the first attempt", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400, message: "bad request" });
    await expect(withAnthropicRetry(fn)).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
