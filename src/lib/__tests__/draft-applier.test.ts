import { describe, it, expect } from "vitest";
import { applyToDraft } from "../draft-applier.js";
import type { CreateAgentBody } from "../agent-from-config.js";
import type { ProposedChange } from "../call-findings.js";

function exportConfig(overrides: Partial<CreateAgentBody["business"]> = {}): CreateAgentBody {
  return {
    business: {
      businessName: "Acme HVAC",
      faqKnowledgeBase: "Hours: 8 to 5.",
      introFinetuneExamples: [],
      ...overrides,
    },
    client: {
      slug: "acme-hvac",
      dispatch_text_numbers: [],
    },
  } as CreateAgentBody;
}

function pc(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    kind: "add_faq_entry",
    payload: { entry: "After hours: $50 trip charge applies." },
    diff_preview: { before: "—", after: "After hours: $50 trip charge applies." },
    ...overrides,
  };
}

describe("applyToDraft — add_faq_entry", () => {
  it("appends to faqKnowledgeBase", () => {
    const r = applyToDraft(pc({}), exportConfig());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.business.faqKnowledgeBase).toBe(
      "Hours: 8 to 5.\n\nAfter hours: $50 trip charge applies.",
    );
  });

  it("uses entry alone when FAQ is empty", () => {
    const r = applyToDraft(pc({}), exportConfig({ faqKnowledgeBase: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.business.faqKnowledgeBase).toBe("After hours: $50 trip charge applies.");
  });

  it("rejects an empty entry payload", () => {
    expect(applyToDraft(pc({ payload: { entry: "" } }), exportConfig()).ok).toBe(false);
    expect(applyToDraft(pc({ payload: {} }), exportConfig()).ok).toBe(false);
  });

  it("skips when entry already present (idempotent)", () => {
    const r = applyToDraft(
      pc({ payload: { entry: "Hours: 8 to 5." } }),
      exportConfig(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already contains/);
    expect(r.notPropagatable).toBeUndefined();
  });

  it("does not mutate the input exportConfig", () => {
    const cfg = exportConfig();
    const original = cfg.business.faqKnowledgeBase;
    const r = applyToDraft(pc({}), cfg);
    expect(r.ok).toBe(true);
    expect(cfg.business.faqKnowledgeBase).toBe(original);
  });
});

describe("applyToDraft — edit_close_transition", () => {
  const change = pc({
    kind: "edit_close_transition",
    target_path_name: "dispatch",
    payload: { append: "Before we wrap up, anything else you'd like to know?" },
    diff_preview: { before: "Thank you…", after: "Thank you…\n\nBefore we wrap up…" },
  });

  it("writes pathClosePrompts for the targeted path", () => {
    const r = applyToDraft(change, exportConfig({ closePrompt: "Thank you for calling." }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.business.pathClosePrompts).toBeDefined();
    expect(r.next.business.pathClosePrompts!.dispatch).toContain("Thank you for calling.");
    expect(r.next.business.pathClosePrompts!.dispatch).toContain("Before we wrap up");
  });

  it("preserves other paths in pathClosePrompts", () => {
    const cfg = exportConfig({
      closePrompt: "Thank you for calling.",
      pathClosePrompts: { other: "See ya." },
    });
    const r = applyToDraft(change, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.business.pathClosePrompts!.other).toBe("See ya.");
    expect(r.next.business.pathClosePrompts!.dispatch).toContain("Before we wrap up");
  });

  it("falls back to global closePrompt when no path is given", () => {
    const r = applyToDraft(
      { ...change, target_path_name: undefined },
      exportConfig({ closePrompt: "Thank you for calling." }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.business.closePrompt).toContain("Thank you for calling.");
    expect(r.next.business.closePrompt).toContain("Before we wrap up");
  });

  it("rejects empty append payload", () => {
    expect(applyToDraft({ ...change, payload: {} }, exportConfig()).ok).toBe(false);
    expect(applyToDraft({ ...change, payload: { append: "  " } }, exportConfig()).ok).toBe(false);
  });
});

describe("applyToDraft — non-propagatable kinds", () => {
  it("edit_collect_prompt is not propagatable", () => {
    const r = applyToDraft(pc({ kind: "edit_collect_prompt", target_variable_name: "x", payload: { append: "y" } }), exportConfig());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("add_finetune_example is not propagatable", () => {
    const r = applyToDraft(
      pc({
        kind: "add_finetune_example",
        target_variable_name: "x",
        payload: { user: "u", agent: "a" },
      }),
      exportConfig(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("edit_router_branch is not propagatable", () => {
    const r = applyToDraft(pc({ kind: "edit_router_branch", payload: { note: "x" } }), exportConfig());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("split_data_point is not propagatable", () => {
    const r = applyToDraft(pc({ kind: "split_data_point", payload: { note: "x" } }), exportConfig());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });
});
