import { describe, it, expect } from "vitest";
import { parseAnalyzerResponse } from "../transcript-analyzer.js";

const trace = { systemPrompt: "", userMessage: "", rawContentBlocks: "[]" };

function rawFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "unanswered_question",
    severity: "high",
    transcript_excerpt: "User: will there be an after hours charge?\nAgent: thank you for the info.",
    description: "Caller asked about after-hours fees and the agent moved to close without answering.",
    proposed_change: {
      kind: "add_faq_entry",
      payload: { entry: "After hours: a $50 trip charge applies after 5pm." },
      diff_preview: {
        before: "—",
        after: "After hours: a $50 trip charge applies after 5pm.",
      },
    },
    ...overrides,
  };
}

describe("parseAnalyzerResponse — happy path", () => {
  it("returns empty findings when the model emits an empty array", () => {
    const r = parseAnalyzerResponse(`{"findings": []}`, trace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toEqual([]);
  });

  it("returns empty findings on completely empty response", () => {
    const r = parseAnalyzerResponse("", trace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toEqual([]);
  });

  it("strips markdown fences before parsing", () => {
    const r = parseAnalyzerResponse(
      "```json\n" + JSON.stringify({ findings: [rawFinding()] }) + "\n```",
      trace,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].type).toBe("unanswered_question");
  });

  it("preserves all six finding types", () => {
    const types = [
      "unanswered_question",
      "misheard_confirmation",
      "repeated_data",
      "frustration_signal",
      "premature_termination",
      "path_misroute",
    ] as const;
    const findings = types.map((t) => rawFinding({ type: t }));
    const r = parseAnalyzerResponse(JSON.stringify({ findings }), trace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.map((f) => f.type)).toEqual(types);
  });

  it("preserves proposed_change target fields when present", () => {
    const f = rawFinding({
      proposed_change: {
        kind: "add_finetune_example",
        target_node_id: "node-collect-name",
        target_path_name: "dispatch",
        target_variable_name: "full_name",
        payload: { user: "x", agent: "y" },
        diff_preview: { before: "—", after: "added" },
      },
    });
    const r = parseAnalyzerResponse(JSON.stringify({ findings: [f] }), trace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pc = r.findings[0].proposed_change;
    expect(pc.target_node_id).toBe("node-collect-name");
    expect(pc.target_path_name).toBe("dispatch");
    expect(pc.target_variable_name).toBe("full_name");
  });
});

// ── Failure modes ──────────────────────────────────────────────────────────

describe("parseAnalyzerResponse — strict validation", () => {
  it("returns ok:false when response is not valid JSON", () => {
    const r = parseAnalyzerResponse("this is not json", trace);
    expect(r.ok).toBe(false);
  });

  it("returns ok:false when `findings` key is missing", () => {
    const r = parseAnalyzerResponse(`{"foo": []}`, trace);
    expect(r.ok).toBe(false);
  });

  it("drops an individual finding with an unknown type but keeps the rest", () => {
    const findings = [
      rawFinding(),
      rawFinding({ type: "made_up_type" }),
      rawFinding({ type: "misheard_confirmation" }),
    ];
    const r = parseAnalyzerResponse(JSON.stringify({ findings }), trace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.type)).toEqual([
      "unanswered_question",
      "misheard_confirmation",
    ]);
  });

  it("drops a finding with an unknown remediation kind", () => {
    const findings = [
      rawFinding({
        proposed_change: {
          kind: "rewrite_universe",
          payload: {},
          diff_preview: { before: "—", after: "x" },
        },
      }),
    ];
    const r = parseAnalyzerResponse(JSON.stringify({ findings }), trace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(0);
  });

  it("drops a finding missing diff_preview.after", () => {
    const findings = [
      rawFinding({
        proposed_change: {
          kind: "add_faq_entry",
          payload: { entry: "x" },
          diff_preview: { before: "—" },
        },
      }),
    ];
    const r = parseAnalyzerResponse(JSON.stringify({ findings }), trace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(0);
  });

  it("drops a finding missing transcript_excerpt or description", () => {
    expect(
      parseAnalyzerResponse(
        JSON.stringify({ findings: [rawFinding({ transcript_excerpt: "" })] }),
        trace,
      ),
    ).toMatchObject({ ok: true, findings: [] });
    expect(
      parseAnalyzerResponse(
        JSON.stringify({ findings: [rawFinding({ description: "" })] }),
        trace,
      ),
    ).toMatchObject({ ok: true, findings: [] });
  });

  it("drops a finding with an unknown severity", () => {
    const r = parseAnalyzerResponse(
      JSON.stringify({ findings: [rawFinding({ severity: "catastrophic" })] }),
      trace,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(0);
  });
});
