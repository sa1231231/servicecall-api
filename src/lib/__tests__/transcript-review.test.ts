import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocked deps ─────────────────────────────────────────────────────────────

const {
  mockGetClientDocument,
  mockAnalyze,
  mockInsertFindings,
  mockCreateSuggestion,
} = vi.hoisted(() => ({
  mockGetClientDocument: vi.fn(),
  mockAnalyze: vi.fn(),
  mockInsertFindings: vi.fn(async (docs: any[]) => docs.map((d, i) => ({ ...d, _id: `f${i}` }))),
  mockCreateSuggestion: vi.fn(async (s: any) => ({ ...s, _id: "s1" })),
}));

vi.mock("../../config/client-store.js", () => ({
  getClientDocument: (...a: any[]) => mockGetClientDocument(...a),
}));

vi.mock("../../_cache/clients.js", () => ({
  agentIdToSlug: { agent_x: "client-a" },
}));

vi.mock("../transcript-analyzer.js", () => ({
  analyzeTranscript: (...a: any[]) => mockAnalyze(...a),
  buildAgentContext: () => "context-string",
}));

vi.mock("../call-findings.js", () => ({
  insertFindings: (...a: unknown[]) => (mockInsertFindings as any)(...a),
}));

vi.mock("../improvement-suggestions.js", () => ({
  createSuggestion: (...a: unknown[]) => (mockCreateSuggestion as any)(...a),
}));

// node-parser is real — buildAgentContext is mocked above. Don't mock the
// parser since the orchestrator calls it inside a try/catch.

// Module under test (imported AFTER mocks)
const { runTranscriptReview } = await import("../transcript-review.js");

// ── Fixture builders ────────────────────────────────────────────────────────

function call(overrides: Partial<Record<string, any>> = {}) {
  return {
    call_id: "call_123",
    transcript: "A".repeat(500),
    duration_ms: 60_000,
    disconnection_reason: "user_hangup",
    collected_dynamic_variables: { full_name: "Rick" },
    retell_llm_dynamic_variables: {},
    ...overrides,
  };
}

function clientDoc(overrides: Record<string, unknown> = {}) {
  return {
    name: "Client A",
    agent_id: "agent_x",
    transcript_review_enabled: true,
    source_draft: "HVAC",
    retell_agents: {},
    ...overrides,
  };
}

beforeEach(() => {
  for (const m of [mockGetClientDocument, mockAnalyze, mockInsertFindings, mockCreateSuggestion]) {
    m.mockClear();
  }
  mockInsertFindings.mockImplementation(async (docs: any[]) =>
    docs.map((d, i) => ({ ...d, _id: `f${i}` })),
  );
});

// ── Skip rules ──────────────────────────────────────────────────────────────

describe("runTranscriptReview — skip rules", () => {
  it("skips shadow/test calls without calling the analyzer", async () => {
    await runTranscriptReview({
      callId: "call_1",
      agentId: "agent_x",
      call: call(),
      isShadowOrTest: true,
    });
    expect(mockGetClientDocument).not.toHaveBeenCalled();
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("skips when the agent has no client mapping", async () => {
    await runTranscriptReview({
      callId: "call_1",
      agentId: "ghost_agent",
      call: call(),
      isShadowOrTest: false,
    });
    expect(mockGetClientDocument).not.toHaveBeenCalled();
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("skips when transcript_review_enabled is unset (default-off opt-in)", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc({ transcript_review_enabled: false }));
    await runTranscriptReview({
      callId: "call_1",
      agentId: "agent_x",
      call: call(),
      isShadowOrTest: false,
    });
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("skips when the transcript is too short", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    await runTranscriptReview({
      callId: "call_1",
      agentId: "agent_x",
      call: call({ transcript: "short" }),
      isShadowOrTest: false,
    });
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("skips when call duration is below the minimum", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    await runTranscriptReview({
      callId: "call_1",
      agentId: "agent_x",
      call: call({ duration_ms: 5_000 }),
      isShadowOrTest: false,
    });
    expect(mockAnalyze).not.toHaveBeenCalled();
  });
});

// ── Happy path ──────────────────────────────────────────────────────────────

describe("runTranscriptReview — happy path", () => {
  it("persists findings + 1:1 suggestions when analyzer returns findings", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockAnalyze.mockResolvedValue({
      ok: true,
      findings: [
        {
          type: "unanswered_question",
          severity: "high",
          transcript_span: { excerpt: "snippet" },
          description: "agent dodged the fee question",
          proposed_change: {
            kind: "add_faq_entry",
            payload: { entry: "After hours: $50 trip charge." },
            diff_preview: { before: "—", after: "After hours: $50 trip charge." },
          },
          ai_trace: { systemPrompt: "", userMessage: "", rawContentBlocks: "" },
        },
      ],
      trace: { systemPrompt: "sys", userMessage: "usr", rawContentBlocks: "[]" },
    });

    await runTranscriptReview({
      callId: "call_1",
      agentId: "agent_x",
      call: call(),
      isShadowOrTest: false,
    });

    expect(mockInsertFindings).toHaveBeenCalledTimes(1);
    const inserted = mockInsertFindings.mock.calls[0][0] as any[];
    expect(inserted).toHaveLength(1);
    expect(inserted[0].source_draft).toBe("HVAC");
    expect(inserted[0].ai_trace.systemPrompt).toBe("sys");

    expect(mockCreateSuggestion).toHaveBeenCalledTimes(1);
    const sugg = mockCreateSuggestion.mock.calls[0][0];
    expect(sugg.scope).toBe("agent");
    expect(sugg.scope_target).toBe("agent_x");
    expect(sugg.finding_ids).toEqual(["f0"]);
  });

  it("creates no suggestions when analyzer returns zero findings", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockAnalyze.mockResolvedValue({
      ok: true,
      findings: [],
      trace: { systemPrompt: "", userMessage: "", rawContentBlocks: "[]" },
    });

    await runTranscriptReview({
      callId: "call_1",
      agentId: "agent_x",
      call: call(),
      isShadowOrTest: false,
    });

    expect(mockInsertFindings).not.toHaveBeenCalled();
    expect(mockCreateSuggestion).not.toHaveBeenCalled();
  });

  it("does not throw or persist when analyzer fails", async () => {
    mockGetClientDocument.mockResolvedValue(clientDoc());
    mockAnalyze.mockResolvedValue({
      ok: false,
      error: "Anthropic timeout",
      trace: { systemPrompt: "", userMessage: "", rawContentBlocks: "[]" },
    });

    await expect(
      runTranscriptReview({
        callId: "call_1",
        agentId: "agent_x",
        call: call(),
        isShadowOrTest: false,
      }),
    ).resolves.toBeUndefined();
    expect(mockInsertFindings).not.toHaveBeenCalled();
  });
});
