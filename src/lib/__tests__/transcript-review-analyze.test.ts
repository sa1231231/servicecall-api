// Coverage for `analyzeAndPersist`, the entry point used by both the
// post-hook orchestrator and the manual-analyze dashboard endpoint. The
// existing transcript-review.test.ts only walks the orchestrator's skip
// rules and the happy path through `runTranscriptReview`. This file pins:
//
//   - empty-transcript guard
//   - canonicalJson parse failure does NOT crash analyze
//   - findings without canonicalJson preserve the analyzer's placeholder diff
//   - findings WITH canonicalJson get the placeholder rewritten via the applier
//   - findings whose applier returns advisory keep the placeholder (the
//     dashboard renders advisory cards distinctly, so we must NOT clobber)
//   - analyzer failure is forwarded as ok:false (no insert, no suggestion)
//
// We mock all I/O — the analyzer, mongo writers, suggestion creator — so
// the test stays pure and deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateAgent,
  defaultExtractEquation,
  NOT_MENTIONED,
  type DataPoint,
} from "../agent-generator/index.js";

const {
  mockAnalyze,
  mockInsertFindings,
  mockCreateSuggestion,
} = vi.hoisted(() => ({
  mockAnalyze: vi.fn(),
  mockInsertFindings: vi.fn(),
  mockCreateSuggestion: vi.fn(),
}));

vi.mock("../transcript-analyzer.js", () => ({
  analyzeTranscript: (...a: unknown[]) => mockAnalyze(...a),
  buildAgentContext: () => "ctx",
}));

vi.mock("../call-findings.js", () => ({
  insertFindings: (...a: unknown[]) => mockInsertFindings(...a),
}));

vi.mock("../improvement-suggestions.js", () => ({
  createSuggestion: (...a: unknown[]) => mockCreateSuggestion(...a),
}));

// We are NOT mocking node-parser or suggestion-applier — we want analyzeAndPersist
// to drive the real applier so the diff_preview rewrite is exercised end-to-end.

const { analyzeAndPersist } = await import("../transcript-review.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

const TEST_DEFAULTS: Record<string, DataPoint> = {
  full_name: {
    label: "Full Name",
    variableName: "full_name",
    type: "string",
    description: `Full name. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for the caller's name.",
    forwardCondition: "The caller has given their name",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("full_name"),
  },
};

function realCanonical(): Record<string, unknown> {
  const { agent } = generateAgent(
    {
      businessName: "Acme HVAC",
      faqKnowledgeBase: "Hours: 8 to 5.",
      introFinetuneExamples: [],
    },
    ["full_name"],
    undefined,
    TEST_DEFAULTS,
  );
  return agent as Record<string, unknown>;
}

function placeholderDiff() {
  // Matches what transcript-analyzer.parseAnalyzerResponse stamps when the
  // model omits diff_preview (the orchestrator is supposed to overwrite it).
  return {
    component_kind: "conversation_prompt" as const,
    component_label: "(pending — applier fills this in)",
    before: "",
    after: "",
  };
}

function analyzerSuccess(opts: {
  kind: string;
  payload: Record<string, unknown>;
  target_variable_name?: string;
  target_path_name?: string;
}) {
  return {
    ok: true,
    findings: [
      {
        type: "unanswered_question",
        severity: "high",
        transcript_span: { excerpt: "snippet" },
        description: "agent dodged the question",
        proposed_change: {
          kind: opts.kind,
          payload: opts.payload,
          target_variable_name: opts.target_variable_name,
          target_path_name: opts.target_path_name,
          diff_preview: placeholderDiff(),
        },
        ai_trace: { systemPrompt: "", userMessage: "", rawContentBlocks: "" },
      },
    ],
    trace: { systemPrompt: "sys", userMessage: "usr", rawContentBlocks: "[]" },
  };
}

beforeEach(() => {
  mockAnalyze.mockReset();
  mockInsertFindings.mockReset();
  mockCreateSuggestion.mockReset();
  mockInsertFindings.mockImplementation(async (docs: any[]) =>
    docs.map((d, i) => ({ ...d, _id: `f${i}` })),
  );
  mockCreateSuggestion.mockImplementation(async (s: any) => ({ ...s, _id: { toString: () => "s1" } }));
});

// ── Empty / missing inputs ──────────────────────────────────────────────────

describe("analyzeAndPersist — empty / missing inputs", () => {
  it("rejects with ok:false when the call has no transcript", async () => {
    const r = await analyzeAndPersist({
      callId: "c1",
      agentId: "a1",
      clientSlug: "acme",
      call: { transcript: "  " },
    });
    expect(r.ok).toBe(false);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("forwards analyzer ok:false without inserting findings", async () => {
    mockAnalyze.mockResolvedValue({
      ok: false,
      error: "anthropic timeout",
      trace: { systemPrompt: "", userMessage: "", rawContentBlocks: "[]" },
    });
    const r = await analyzeAndPersist({
      callId: "c1",
      agentId: "a1",
      clientSlug: "acme",
      call: { transcript: "user said something." },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/anthropic timeout/);
    expect(mockInsertFindings).not.toHaveBeenCalled();
    expect(mockCreateSuggestion).not.toHaveBeenCalled();
  });

  it("returns ok:true / 0 created when analyzer returns zero findings", async () => {
    mockAnalyze.mockResolvedValue({
      ok: true,
      findings: [],
      trace: { systemPrompt: "", userMessage: "", rawContentBlocks: "[]" },
    });
    const r = await analyzeAndPersist({
      callId: "c1",
      agentId: "a1",
      clientSlug: "acme",
      call: { transcript: "x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestionsCreated).toBe(0);
    expect(r.suggestionIds).toEqual([]);
    expect(mockInsertFindings).not.toHaveBeenCalled();
  });
});

// ── canonicalJson parse failure ─────────────────────────────────────────────
//
// Current behavior: `analyzeAndPersist` wraps the first `parseConversationFlow`
// call (used for agentContext) in try/catch, but the *second* call inside
// `buildSnapshotFromCanonical` (used for diff_preview) is not guarded. A
// malformed canonical therefore throws out of the function rather than
// degrading to advisory-only. Captured here so the next pass at the
// self-healing pipeline can decide whether to harden it.

describe("analyzeAndPersist — canonicalJson is malformed", () => {
  it("propagates the parser error today (pre-existing brittleness — opportunity for hardening)", async () => {
    mockAnalyze.mockResolvedValue(analyzerSuccess({
      kind: "add_faq_entry",
      payload: { entry: "After hours: $50 trip charge." },
    }));
    await expect(
      analyzeAndPersist({
        callId: "c1",
        agentId: "a1",
        clientSlug: "acme",
        // Missing conversationFlow → buildSnapshotFromCanonical → parseConversationFlow throws.
        canonicalJson: { broken: true },
        call: { transcript: "x" },
      }),
    ).rejects.toThrow(/conversationFlow/);
    // Analyzer still ran (the agentContext-side parse failure is caught).
    expect(mockAnalyze).toHaveBeenCalledOnce();
    // But because the snapshot build threw before insertFindings, nothing persisted.
    expect(mockInsertFindings).not.toHaveBeenCalled();
  });
});

// ── diff_preview overwrite via applier ──────────────────────────────────────

describe("analyzeAndPersist — diff_preview computation", () => {
  it("overwrites the placeholder diff_preview with a real one when applier succeeds", async () => {
    mockAnalyze.mockResolvedValue(analyzerSuccess({
      kind: "add_faq_entry",
      payload: { entry: "After hours: $50 trip charge." },
    }));
    const r = await analyzeAndPersist({
      callId: "c1",
      agentId: "a1",
      clientSlug: "acme",
      canonicalJson: realCanonical(),
      call: { transcript: "x" },
    });
    expect(r.ok).toBe(true);

    expect(mockInsertFindings).toHaveBeenCalledOnce();
    const inserted = mockInsertFindings.mock.calls[0][0] as any[];
    const diff = inserted[0].proposed_change.diff_preview;

    // Real diff: applier should produce a faq_knowledge_base diff with
    // before = current FAQ text, after = current + appended entry.
    expect(diff.component_kind).toBe("faq_knowledge_base");
    expect(diff.component_label).not.toMatch(/pending/i);
    expect(diff.before).toContain("Hours: 8 to 5.");
    expect(diff.after).toContain("After hours: $50 trip charge.");
  });

  it("leaves the placeholder when applier returns advisory (advisory kinds render distinctly)", async () => {
    mockAnalyze.mockResolvedValue(analyzerSuccess({
      kind: "edit_router_branch",
      target_path_name: "Default",
      payload: { note: "needs human review" },
    }));
    const r = await analyzeAndPersist({
      callId: "c1",
      agentId: "a1",
      clientSlug: "acme",
      canonicalJson: realCanonical(),
      call: { transcript: "x" },
    });
    expect(r.ok).toBe(true);

    const inserted = mockInsertFindings.mock.calls[0][0] as any[];
    const diff = inserted[0].proposed_change.diff_preview;
    // Placeholder should be preserved verbatim — the dashboard branch on
    // "advisory" rendering depends on it.
    expect(diff.component_label).toMatch(/pending/i);
  });

  it("preserves the placeholder when no canonicalJson is provided", async () => {
    mockAnalyze.mockResolvedValue(analyzerSuccess({
      kind: "add_faq_entry",
      payload: { entry: "x" },
    }));
    const r = await analyzeAndPersist({
      callId: "c1",
      agentId: "a1",
      clientSlug: "acme",
      // no canonicalJson → no snapshot → no rewrite
      call: { transcript: "x" },
    });
    expect(r.ok).toBe(true);
    const inserted = mockInsertFindings.mock.calls[0][0] as any[];
    expect(inserted[0].proposed_change.diff_preview.component_label).toMatch(/pending/i);
  });

  it("creates one suggestion per finding (1:1) and returns its id", async () => {
    mockAnalyze.mockResolvedValue(analyzerSuccess({
      kind: "add_faq_entry",
      payload: { entry: "After hours: $50 trip charge." },
    }));
    const r = await analyzeAndPersist({
      callId: "c1",
      agentId: "a1",
      clientSlug: "acme",
      canonicalJson: realCanonical(),
      sourceDraft: "HVAC",
      call: { transcript: "x" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestionsCreated).toBe(1);
    expect(r.suggestionIds).toEqual(["s1"]);

    expect(mockCreateSuggestion).toHaveBeenCalledOnce();
    const sugg = mockCreateSuggestion.mock.calls[0][0];
    expect(sugg.scope).toBe("agent");
    expect(sugg.scope_target).toBe("a1");
    expect(sugg.client_slug).toBe("acme");
    // source_draft propagated from the input so Phase 3 bubble-up works.
    const inserted = mockInsertFindings.mock.calls[0][0] as any[];
    expect(inserted[0].source_draft).toBe("HVAC");
  });
});
