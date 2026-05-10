import { describe, it, expect } from "vitest";
import {
  buildPublishPayload,
  type ApplierSnapshot,
} from "../suggestion-applier.js";
import type { ProposedChange } from "../call-findings.js";

function snapshot(overrides: Partial<ApplierSnapshot> = {}): ApplierSnapshot {
  return {
    globalPrompt: "Be helpful.",
    faqKnowledgeBase: "Hours: 8 to 5 weekdays.",
    introNodeId: "node-intro",
    introPrompt: "Hi, this is the receptionist.",
    introFinetuneExamples: [],
    paths: [
      {
        name: "dispatch",
        transitionNodeId: "node-transition-dispatch",
        transitionPrompt: "User wants service",
        closePrompt: "Thank you for calling. Goodbye.",
        dataPoints: [
          {
            variableName: "full_name",
            label: "Full Name",
            collectNodeId: "node-collect-name",
            conversationPrompt: "Ask for the caller's full name.",
            finetuneExamples: [
              {
                transcript: [
                  { content: "hi", role: "user" as const },
                  { content: "hello", role: "agent" as const },
                ],
                type: "negative" as const,
              },
            ],
          },
          {
            variableName: "phone_number",
            label: "Phone Number",
            collectNodeId: "node-collect-phone",
            conversationPrompt: "Ask for the best callback number.",
            finetuneExamples: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function pc(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    kind: "add_faq_entry",
    payload: { entry: "After hours: $50 trip charge applies." },
    diff_preview: {
      component_kind: "faq_knowledge_base" as const,
      component_label: "FAQ knowledge base",
      before: "—",
      after: "After hours: $50 trip charge applies.",
    },
    ...overrides,
  };
}

// ── add_faq_entry ───────────────────────────────────────────────────────────

describe("add_faq_entry", () => {
  it("appends to existing FAQ", () => {
    const result = buildPublishPayload(pc({}), snapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const faq = (result.payload.changes as { faqKnowledgeBase: string }).faqKnowledgeBase;
    expect(faq).toBe("Hours: 8 to 5 weekdays.\n\nAfter hours: $50 trip charge applies.");
  });

  it("uses the entry alone when FAQ is empty", () => {
    const result = buildPublishPayload(pc({}), snapshot({ faqKnowledgeBase: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.payload.changes as any).faqKnowledgeBase).toBe("After hours: $50 trip charge applies.");
  });

  it("rejects when entry is missing or empty", () => {
    expect(buildPublishPayload(pc({ payload: {} }), snapshot()).ok).toBe(false);
    expect(buildPublishPayload(pc({ payload: { entry: "   " } }), snapshot()).ok).toBe(false);
  });

  it("skips when the entry is already present (idempotent)", () => {
    const r = buildPublishPayload(
      pc({ payload: { entry: "Hours: 8 to 5 weekdays." } }),
      snapshot(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already contains/);
  });
});

// ── edit_collect_prompt ─────────────────────────────────────────────────────

describe("edit_collect_prompt", () => {
  const change = pc({
    kind: "edit_collect_prompt",
    target_variable_name: "full_name",
    payload: { append: "If the caller restarts, capture only the final spelling." },
    diff_preview: {
      component_kind: "conversation_prompt" as const,
      component_label: "Collect Full Name — conversation prompt",
      before: "Ask for…",
      after: "Ask for…\n\nIf the caller restarts…",
    },
  });

  it("targets the collect node id and merges the prompt", () => {
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const np = (r.payload.changes as any).nodePrompts as Record<string, string>;
    expect(Object.keys(np)).toEqual(["node-collect-name"]);
    expect(np["node-collect-name"]).toContain("Ask for the caller's full name.");
    expect(np["node-collect-name"]).toContain("If the caller restarts, capture only the final spelling.");
  });

  it("rejects when the variable doesn't exist on any path", () => {
    const r = buildPublishPayload(
      { ...change, target_variable_name: "ghost" },
      snapshot(),
    );
    expect(r.ok).toBe(false);
  });

  it("requires target_variable_name", () => {
    const r = buildPublishPayload({ ...change, target_variable_name: undefined }, snapshot());
    expect(r.ok).toBe(false);
  });
});

// ── add_finetune_example ────────────────────────────────────────────────────

describe("add_finetune_example", () => {
  const change = pc({
    kind: "add_finetune_example",
    target_variable_name: "full_name",
    payload: { user: "R-I-C-K-S-E-C-O-R", agent: "Got it, Rick Secor." },
    diff_preview: {
      component_kind: "finetune_examples" as const,
      component_label: "Collect Full Name — finetune examples",
      before: "(no examples yet)",
      after: "added one positive example",
    },
  });

  it("appends a positive example to the existing array", () => {
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ft = (r.payload.changes as any).dataPointFinetunes as Record<string, any[]>;
    const arr = ft["node-collect-name"];
    expect(arr).toHaveLength(2);
    expect(arr[0].transcript).toEqual([
      { content: "hi", role: "user" },
      { content: "hello", role: "agent" },
    ]);
    expect(arr[1].transcript).toEqual([
      { content: "R-I-C-K-S-E-C-O-R", role: "user" },
      { content: "Got it, Rick Secor.", role: "agent" },
    ]);
    expect(arr[1].type).toBe("positive");
  });

  it("rejects when user or agent turn is empty", () => {
    expect(buildPublishPayload({ ...change, payload: { user: "", agent: "x" } }, snapshot()).ok).toBe(false);
    expect(buildPublishPayload({ ...change, payload: { user: "x", agent: " " } }, snapshot()).ok).toBe(false);
  });

  it("skips when an equivalent example already exists", () => {
    const snap = snapshot();
    snap.paths[0].dataPoints[0].finetuneExamples.push({
      transcript: [
        { content: "R-I-C-K-S-E-C-O-R", role: "user" as const },
        { content: "Got it, Rick Secor.", role: "agent" as const },
      ],
      type: "positive" as const,
    });
    const r = buildPublishPayload(change, snap);
    expect(r.ok).toBe(false);
  });
});

// ── edit_close_transition ───────────────────────────────────────────────────

describe("edit_close_transition", () => {
  const change = pc({
    kind: "edit_close_transition",
    target_path_name: "dispatch",
    payload: { append: "Before we wrap up, is there anything else you'd like to know?" },
    diff_preview: {
      component_kind: "conversation_prompt" as const,
      component_label: "Close (dispatch) — conversation prompt",
      before: "Thank you…",
      after: "Thank you…\n\nBefore we wrap up…",
    },
  });

  it("appends to the path's existing close prompt", () => {
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const close = (r.payload.changes as any).pathClosePrompts as Record<string, string>;
    expect(close.dispatch).toContain("Thank you for calling.");
    expect(close.dispatch).toContain("Before we wrap up");
  });

  it("rejects an unknown path name", () => {
    expect(buildPublishPayload({ ...change, target_path_name: "ghost" }, snapshot()).ok).toBe(false);
  });

  it("requires target_path_name", () => {
    expect(buildPublishPayload({ ...change, target_path_name: undefined }, snapshot()).ok).toBe(false);
  });
});

// ── advisory-only kinds ─────────────────────────────────────────────────────

describe("advisory-only kinds", () => {
  it("edit_router_branch is advisory", () => {
    const r = buildPublishPayload(
      pc({ kind: "edit_router_branch", target_path_name: "dispatch", payload: { note: "x" } }),
      snapshot(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.advisoryOnly).toBe(true);
  });

  it("split_data_point is advisory", () => {
    const r = buildPublishPayload(
      pc({ kind: "split_data_point", payload: { note: "x" } }),
      snapshot(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.advisoryOnly).toBe(true);
  });
});

// ── description text ────────────────────────────────────────────────────────

describe("description", () => {
  it("includes a truncated snippet for audit logs", () => {
    const r = buildPublishPayload(pc({}), snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.description).toMatch(/Add FAQ entry:/);
  });
});
