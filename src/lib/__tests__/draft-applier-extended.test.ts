// Coverage for kinds added to draft-applier in the structured-diff /
// expanded-edit-catalog commit. The original draft-applier.test.ts pins
// `add_faq_entry` and `edit_close_transition`; this file covers the new
// ones — `edit_intro_transition`, `add_intro_finetune` (path / faq /
// negative routes), `edit_close_prompt` precise alias — plus the new
// not-propagatable kinds.

import { describe, it, expect } from "vitest";
import { applyToDraft } from "../draft-applier.js";
import type { CreateAgentBody } from "../agent-from-config.js";
import type { ProposedChange } from "../call-findings.js";

function exportConfig(
  businessOverrides: Partial<CreateAgentBody["business"]> = {},
  paths: CreateAgentBody["paths"] = undefined,
): CreateAgentBody {
  return {
    business: {
      businessName: "Acme HVAC",
      faqKnowledgeBase: "Hours: 8 to 5.",
      introFinetuneExamples: [],
      ...businessOverrides,
    },
    client: {
      slug: "acme-hvac",
      dispatch_text_numbers: [],
    },
    paths,
  } as CreateAgentBody;
}

function pc(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    kind: "edit_intro_transition",
    payload: {},
    diff_preview: {
      component_kind: "transition_condition",
      component_label: "x",
      before: "",
      after: "",
    },
    ...overrides,
  };
}

// ── edit_intro_transition (NEW, draft side) ─────────────────────────────────

describe("applyToDraft — edit_intro_transition", () => {
  const change = pc({
    kind: "edit_intro_transition",
    target_path_name: "dispatch",
    payload: { append: "Only route here on a service-problem mention." },
  });

  it("appends to paths[i].transitionCondition for the targeted path", () => {
    const cfg = exportConfig({}, [
      { name: "dispatch", transitionCondition: "User wants service", dataPoints: [] },
      { name: "quote", transitionCondition: "User wants pricing", dataPoints: [] },
    ] as CreateAgentBody["paths"]);
    const r = applyToDraft(change, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dispatch = r.next.paths!.find((p) => p.name === "dispatch")!;
    expect(dispatch.transitionCondition).toContain("User wants service");
    expect(dispatch.transitionCondition).toContain("Only route here on a service-problem mention.");
    const quote = r.next.paths!.find((p) => p.name === "quote")!;
    expect(quote.transitionCondition).toBe("User wants pricing");
  });

  it("requires target_path_name", () => {
    const r = applyToDraft({ ...change, target_path_name: undefined }, exportConfig());
    expect(r.ok).toBe(false);
  });

  it("rejects empty append", () => {
    expect(applyToDraft({ ...change, payload: {} }, exportConfig({}, [])).ok).toBe(false);
    expect(applyToDraft({ ...change, payload: { append: "" } }, exportConfig({}, [])).ok).toBe(false);
  });

  it("flags non-propagatable when the draft has no matching path (e.g. single-path drafts)", () => {
    const cfg = exportConfig({}, [
      { name: "Default", transitionCondition: "", dataPoints: [] },
    ] as CreateAgentBody["paths"]);
    const r = applyToDraft(change, cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("is idempotent — skips when the addition is already present", () => {
    const cfg = exportConfig({}, [
      {
        name: "dispatch",
        transitionCondition: "Only route here on a service-problem mention.",
        dataPoints: [],
      },
    ] as CreateAgentBody["paths"]);
    const r = applyToDraft(change, cfg);
    expect(r.ok).toBe(false);
  });

  it("does not mutate the input exportConfig", () => {
    const original = "User wants service";
    const cfg = exportConfig({}, [
      { name: "dispatch", transitionCondition: original, dataPoints: [] },
    ] as CreateAgentBody["paths"]);
    applyToDraft(change, cfg);
    expect(cfg.paths![0].transitionCondition).toBe(original);
  });
});

// ── add_intro_finetune (NEW, draft side) ────────────────────────────────────

describe("applyToDraft — add_intro_finetune", () => {
  const change = pc({
    kind: "add_intro_finetune",
    payload: { user: "I just want a quote", agent: "Sure, I can help with that.", routes_to: "quote" },
  });

  it("appends to paths[i].transitionFinetuneExamples for the routed-to path", () => {
    const cfg = exportConfig({}, [
      { name: "dispatch", transitionCondition: "x", dataPoints: [] },
      { name: "quote", transitionCondition: "y", dataPoints: [] },
    ] as CreateAgentBody["paths"]);
    const r = applyToDraft(change, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const quote = r.next.paths!.find((p) => p.name === "quote")!;
    expect(quote.transitionFinetuneExamples).toHaveLength(1);
    expect(quote.transitionFinetuneExamples![0].type).toBe("positive");
    expect(quote.transitionFinetuneExamples![0].transcript).toEqual([
      { content: "I just want a quote", role: "user" },
      { content: "Sure, I can help with that.", role: "agent" },
    ]);
  });

  it("preserves existing examples on the same path", () => {
    const existing = {
      transcript: [
        { content: "old user", role: "user" as const },
        { content: "old agent", role: "agent" as const },
      ],
      type: "positive" as const,
    };
    const cfg = exportConfig({}, [
      {
        name: "quote",
        transitionCondition: "y",
        dataPoints: [],
        transitionFinetuneExamples: [existing],
      },
    ] as CreateAgentBody["paths"]);
    const r = applyToDraft(change, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const quote = r.next.paths!.find((p) => p.name === "quote")!;
    expect(quote.transitionFinetuneExamples).toHaveLength(2);
  });

  it("flags routes_to=faq as not-propagatable (no draft home)", () => {
    const r = applyToDraft(
      { ...change, payload: { ...change.payload, routes_to: "faq" } },
      exportConfig({}, [{ name: "any", transitionCondition: "", dataPoints: [] }] as CreateAgentBody["paths"]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("flags routes_to=negative as not-propagatable", () => {
    const r = applyToDraft(
      { ...change, payload: { ...change.payload, routes_to: "negative" } },
      exportConfig({}, [{ name: "any", transitionCondition: "", dataPoints: [] }] as CreateAgentBody["paths"]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("flags unknown destination path as not-propagatable", () => {
    const r = applyToDraft(change, exportConfig({}, [
      { name: "dispatch", transitionCondition: "", dataPoints: [] },
    ] as CreateAgentBody["paths"]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("rejects when user or agent turn is empty", () => {
    const cfg = exportConfig({}, [{ name: "quote", transitionCondition: "", dataPoints: [] }] as CreateAgentBody["paths"]);
    expect(applyToDraft({ ...change, payload: { user: "", agent: "y", routes_to: "quote" } }, cfg).ok).toBe(false);
    expect(applyToDraft({ ...change, payload: { user: "x", agent: "", routes_to: "quote" } }, cfg).ok).toBe(false);
  });

  it("skips when an equivalent example already exists on the path", () => {
    const cfg = exportConfig({}, [
      {
        name: "quote",
        transitionCondition: "",
        dataPoints: [],
        transitionFinetuneExamples: [
          {
            transcript: [
              { content: "I just want a quote", role: "user" as const },
              { content: "Sure, I can help with that.", role: "agent" as const },
            ],
            type: "positive" as const,
          },
        ],
      },
    ] as CreateAgentBody["paths"]);
    const r = applyToDraft(change, cfg);
    expect(r.ok).toBe(false);
  });
});

// ── edit_close_prompt (precise alias for edit_close_transition) ─────────────

describe("applyToDraft — edit_close_prompt (precise alias)", () => {
  it("behaves like edit_close_transition for per-path", () => {
    const r = applyToDraft(
      pc({
        kind: "edit_close_prompt",
        target_path_name: "dispatch",
        payload: { append: "Anything else?" },
      }),
      exportConfig({ closePrompt: "Goodbye." }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next.business.pathClosePrompts!.dispatch).toContain("Anything else?");
  });
});

// ── New not-propagatable kinds ──────────────────────────────────────────────

describe("applyToDraft — non-propagatable kinds (new)", () => {
  it("edit_global_prompt is not propagatable (regenerated at build time)", () => {
    const r = applyToDraft(
      pc({ kind: "edit_global_prompt", payload: { append: "Be polite." } }),
      exportConfig(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
    expect(r.error).toMatch(/regenerated/i);
  });

  it("edit_intro_prompt is not propagatable", () => {
    const r = applyToDraft(
      pc({ kind: "edit_intro_prompt", payload: { append: "Greet by name." } }),
      exportConfig(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("edit_collect_prompt is not propagatable", () => {
    const r = applyToDraft(
      pc({
        kind: "edit_collect_prompt",
        target_variable_name: "full_name",
        payload: { append: "Confirm spelling." },
      }),
      exportConfig(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("add_collect_finetune (new precise name) is not propagatable", () => {
    const r = applyToDraft(
      pc({
        kind: "add_collect_finetune",
        target_variable_name: "full_name",
        payload: { user: "x", agent: "y" },
      }),
      exportConfig(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });

  it("legacy add_finetune_example alias remains not-propagatable", () => {
    const r = applyToDraft(
      pc({
        kind: "add_finetune_example",
        target_variable_name: "full_name",
        payload: { user: "x", agent: "y" },
      }),
      exportConfig(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notPropagatable).toBe(true);
  });
});
