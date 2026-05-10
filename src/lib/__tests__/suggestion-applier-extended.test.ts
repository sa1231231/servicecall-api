// Coverage for the new precise-kind handlers added in the
// "Suggestions: structured diff + expanded edit catalog" commit. The
// original suggestion-applier.test.ts only exercises the legacy aliases
// (add_finetune_example, edit_close_transition); these tests pin the new
// names plus the cases the legacy tests skipped: edit_global_prompt,
// edit_intro_prompt, edit_intro_transition, add_intro_finetune (3
// routes_to branches), edit_close_prompt, plus buildSnapshotFromCanonical.

import { describe, it, expect } from "vitest";
import {
  buildPublishPayload,
  buildSnapshotFromCanonical,
  type ApplierSnapshot,
} from "../suggestion-applier.js";
import type { ProposedChange } from "../call-findings.js";
import {
  generateAgent,
  defaultExtractEquation,
  NOT_MENTIONED,
  type DataPoint,
} from "../agent-generator/index.js";

function snapshot(overrides: Partial<ApplierSnapshot> = {}): ApplierSnapshot {
  return {
    globalPrompt: "Be helpful.",
    faqKnowledgeBase: "Hours: 8 to 5 weekdays.",
    faqNodeId: "node-faq",
    introNodeId: "node-intro",
    introPrompt: "Hi, this is the receptionist.",
    introFinetuneExamples: [],
    paths: [
      {
        name: "dispatch",
        transitionNodeId: "node-transition-dispatch",
        transitionPrompt: "User wants service",
        closeNodeId: "node-close-dispatch",
        closePrompt: "Thank you for calling.",
        dataPoints: [
          {
            variableName: "full_name",
            label: "Full Name",
            collectNodeId: "node-collect-name",
            conversationPrompt: "Ask for the caller's full name.",
            finetuneExamples: [],
          },
        ],
      },
      {
        name: "quote",
        transitionNodeId: "node-transition-quote",
        transitionPrompt: "User wants pricing",
        closeNodeId: "node-close-quote",
        closePrompt: "Goodbye.",
        dataPoints: [],
      },
    ],
    ...overrides,
  };
}

function pc(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    kind: "edit_global_prompt",
    payload: {},
    diff_preview: {
      component_kind: "global_prompt" as const,
      component_label: "x",
      before: "",
      after: "",
    },
    ...overrides,
  };
}

// ── edit_global_prompt ──────────────────────────────────────────────────────

describe("edit_global_prompt", () => {
  it("appends to the global prompt and produces a global_prompt diff", () => {
    const change = pc({
      kind: "edit_global_prompt",
      payload: { append: "Always confirm a callback number before transferring." },
    });
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload.changes as { globalPrompt: string }).globalPrompt).toBe(
      "Be helpful.\n\nAlways confirm a callback number before transferring.",
    );
    expect(r.diff_preview.component_kind).toBe("global_prompt");
    expect(r.diff_preview.before).toBe("Be helpful.");
    expect(r.diff_preview.after).toContain("Always confirm");
  });

  it("uses the addition alone when global prompt is empty", () => {
    const change = pc({ kind: "edit_global_prompt", payload: { append: "New rule." } });
    const r = buildPublishPayload(change, snapshot({ globalPrompt: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload.changes as { globalPrompt: string }).globalPrompt).toBe("New rule.");
  });

  it("rejects when the addition is missing or empty", () => {
    expect(buildPublishPayload(pc({ kind: "edit_global_prompt", payload: {} }), snapshot()).ok).toBe(false);
    expect(buildPublishPayload(pc({ kind: "edit_global_prompt", payload: { append: "  " } }), snapshot()).ok).toBe(false);
  });

  it("is idempotent — skips when the addition is already present", () => {
    const r = buildPublishPayload(
      pc({ kind: "edit_global_prompt", payload: { append: "Be helpful." } }),
      snapshot(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already contains/);
  });
});

// ── edit_intro_prompt ───────────────────────────────────────────────────────

describe("edit_intro_prompt", () => {
  it("appends to the intro node and emits a conversation_prompt diff", () => {
    const change = pc({
      kind: "edit_intro_prompt",
      payload: { append: "Greet by first name when known." },
    });
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload.changes as { introPrompt: string }).introPrompt).toBe(
      "Hi, this is the receptionist.\n\nGreet by first name when known.",
    );
    expect(r.diff_preview.component_kind).toBe("conversation_prompt");
    expect(r.diff_preview.node_label).toBe("Intro");
  });

  it("rejects when the agent has no intro node id", () => {
    const change = pc({
      kind: "edit_intro_prompt",
      payload: { append: "x" },
    });
    const r = buildPublishPayload(change, snapshot({ introNodeId: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no intro node/i);
  });

  it("rejects an empty addition payload", () => {
    expect(buildPublishPayload(pc({ kind: "edit_intro_prompt", payload: {} }), snapshot()).ok).toBe(false);
    expect(buildPublishPayload(pc({ kind: "edit_intro_prompt", payload: { append: "" } }), snapshot()).ok).toBe(false);
  });
});

// ── edit_intro_transition ───────────────────────────────────────────────────

describe("edit_intro_transition", () => {
  const change = pc({
    kind: "edit_intro_transition",
    target_path_name: "dispatch",
    payload: { append: "Only route here if the caller mentioned a service problem." },
  });

  it("writes transitionConditions[pathName] and emits a transition_condition diff", () => {
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tc = (r.payload.changes as any).transitionConditions as Record<string, string>;
    expect(Object.keys(tc)).toEqual(["dispatch"]);
    expect(tc.dispatch).toContain("User wants service");
    expect(tc.dispatch).toContain("Only route here");
    expect(r.diff_preview.component_kind).toBe("transition_condition");
  });

  it("requires target_path_name", () => {
    const r = buildPublishPayload({ ...change, target_path_name: undefined }, snapshot());
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown path name", () => {
    const r = buildPublishPayload({ ...change, target_path_name: "ghost" }, snapshot());
    expect(r.ok).toBe(false);
  });

  it("rejects empty append", () => {
    expect(buildPublishPayload({ ...change, payload: {} }, snapshot()).ok).toBe(false);
    expect(buildPublishPayload({ ...change, payload: { append: " " } }, snapshot()).ok).toBe(false);
  });

  it("is idempotent", () => {
    const r = buildPublishPayload(
      { ...change, payload: { append: "User wants service" } },
      snapshot(),
    );
    expect(r.ok).toBe(false);
  });
});

// ── add_intro_finetune ──────────────────────────────────────────────────────

describe("add_intro_finetune", () => {
  const baseChange = pc({
    kind: "add_intro_finetune",
    payload: { user: "do you offer payment plans?", agent: "I'll connect you to billing." },
  });

  it("default routes_to=negative writes introFinetuneExamples (negatives only)", () => {
    const r = buildPublishPayload(baseChange, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const arr = (r.payload.changes as any).introFinetuneExamples as Array<any>;
    expect(arr).toHaveLength(1);
    expect(arr[0].type).toBe("negative");
    expect(arr[0].destination_node_id).toBeUndefined();
    expect(arr[0].transcript).toEqual([
      { content: "do you offer payment plans?", role: "user" },
      { content: "I'll connect you to billing.", role: "agent" },
    ]);
    expect(r.diff_preview.component_kind).toBe("finetune_examples");
    expect(r.diff_preview.component_label).toMatch(/negative/);
  });

  it("preserves existing negatives, drops positives, when routes_to=negative", () => {
    const snap = snapshot({
      introFinetuneExamples: [
        {
          transcript: [
            { content: "old neg q", role: "user" },
            { content: "old neg a", role: "agent" },
          ],
          type: "negative",
        },
        {
          transcript: [
            { content: "old pos q", role: "user" },
            { content: "old pos a", role: "agent" },
          ],
          type: "positive",
          destination_node_id: "node-transition-dispatch",
        },
      ],
    });
    const r = buildPublishPayload(baseChange, snap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const arr = (r.payload.changes as any).introFinetuneExamples as Array<any>;
    // negatives + new = 2; the positive is intentionally dropped from the negatives bucket
    expect(arr).toHaveLength(2);
    expect(arr.every((ex) => !ex.destination_node_id)).toBe(true);
  });

  it("routes_to=faq returns advisory-shaped payload (no save-and-publish field yet)", () => {
    const change = {
      ...baseChange,
      payload: { ...baseChange.payload, routes_to: "faq" },
    };
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.changes).toEqual({});
    expect(r.diff_preview.component_label).toMatch(/FAQ/);
  });

  it("routes_to=faq fails when the agent has no FAQ node", () => {
    const change = {
      ...baseChange,
      payload: { ...baseChange.payload, routes_to: "faq" },
    };
    const r = buildPublishPayload(change, snapshot({ faqNodeId: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/no FAQ node/i);
  });

  it("routes_to=<path> writes transitionFinetunes[pathName]", () => {
    const change = {
      ...baseChange,
      payload: { ...baseChange.payload, routes_to: "dispatch" },
    };
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tf = (r.payload.changes as any).transitionFinetunes as Record<string, any[]>;
    expect(Object.keys(tf)).toEqual(["dispatch"]);
    expect(tf.dispatch).toHaveLength(1);
    expect(tf.dispatch[0].type).toBe("positive");
    expect(r.diff_preview.component_label).toMatch(/dispatch/);
  });

  it("routes_to=<path> rejects unknown path name", () => {
    const change = { ...baseChange, payload: { ...baseChange.payload, routes_to: "ghost" } };
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(false);
  });

  it("rejects when user or agent turn is empty", () => {
    expect(buildPublishPayload({ ...baseChange, payload: { user: "", agent: "x" } }, snapshot()).ok).toBe(false);
    expect(buildPublishPayload({ ...baseChange, payload: { user: "x", agent: " " } }, snapshot()).ok).toBe(false);
  });

  it("skips when an equivalent example already exists in the same bucket", () => {
    const snap = snapshot({
      introFinetuneExamples: [
        {
          transcript: [
            { content: "do you offer payment plans?", role: "user" },
            { content: "I'll connect you to billing.", role: "agent" },
          ],
          type: "negative",
        },
      ],
    });
    const r = buildPublishPayload(baseChange, snap);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/already exists/i);
  });
});

// ── add_collect_finetune (new precise name; legacy alias tested separately) ─

describe("add_collect_finetune", () => {
  it("appends to the collect node's finetune array and writes dataPointFinetunes", () => {
    const change = pc({
      kind: "add_collect_finetune",
      target_variable_name: "full_name",
      payload: { user: "R-I-C-K", agent: "Got it, Rick." },
    });
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ft = (r.payload.changes as any).dataPointFinetunes as Record<string, any[]>;
    expect(Object.keys(ft)).toEqual(["node-collect-name"]);
    expect(ft["node-collect-name"]).toHaveLength(1);
    expect(ft["node-collect-name"][0].type).toBe("positive");
    expect(r.diff_preview.component_kind).toBe("finetune_examples");
  });

  it("requires target_variable_name", () => {
    const change = pc({
      kind: "add_collect_finetune",
      payload: { user: "x", agent: "y" },
    });
    expect(buildPublishPayload(change, snapshot()).ok).toBe(false);
  });

  it("rejects an unknown variable", () => {
    const change = pc({
      kind: "add_collect_finetune",
      target_variable_name: "ghost",
      payload: { user: "x", agent: "y" },
    });
    expect(buildPublishPayload(change, snapshot()).ok).toBe(false);
  });
});

// ── edit_close_prompt (new precise name) ────────────────────────────────────

describe("edit_close_prompt", () => {
  const change = pc({
    kind: "edit_close_prompt",
    target_path_name: "dispatch",
    payload: { append: "Anything else before we wrap up?" },
  });

  it("appends to the path's close prompt", () => {
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const close = (r.payload.changes as any).pathClosePrompts as Record<string, string>;
    expect(close.dispatch).toContain("Thank you for calling.");
    expect(close.dispatch).toContain("Anything else");
    expect(r.diff_preview.component_kind).toBe("conversation_prompt");
  });

  it("requires target_path_name", () => {
    expect(buildPublishPayload({ ...change, target_path_name: undefined }, snapshot()).ok).toBe(false);
  });

  it("rejects an unknown path name", () => {
    expect(buildPublishPayload({ ...change, target_path_name: "ghost" }, snapshot()).ok).toBe(false);
  });

  it("rejects empty append", () => {
    expect(buildPublishPayload({ ...change, payload: {} }, snapshot()).ok).toBe(false);
  });
});

// ── canonicalKind aliases ───────────────────────────────────────────────────

describe("legacy kind aliasing", () => {
  it("add_finetune_example aliases to add_collect_finetune behavior", () => {
    const change = pc({
      kind: "add_finetune_example",
      target_variable_name: "full_name",
      payload: { user: "x", agent: "y" },
    });
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload.changes as any).dataPointFinetunes).toBeDefined();
  });

  it("edit_close_transition aliases to edit_close_prompt behavior", () => {
    const change = pc({
      kind: "edit_close_transition",
      target_path_name: "dispatch",
      payload: { append: "x" },
    });
    const r = buildPublishPayload(change, snapshot());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.payload.changes as any).pathClosePrompts).toBeDefined();
  });
});

// ── buildSnapshotFromCanonical ──────────────────────────────────────────────
//
// Drive a real canonical agent through generateAgent (the same helper the
// node-parser tests use), then assert that the snapshot exposes the fields
// the applier reads. Hand-rolled fixtures don't survive parseConversationFlow's
// strict naming rules ("Transition (...)", "Variables Router (...)",
// "Extract All Variables"), so we use the real generator.

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
  phone_number: {
    label: "Phone Number",
    variableName: "phone_number",
    type: "string",
    description: `Phone number. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for their phone number.",
    forwardCondition: "The caller has provided their phone number",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("phone_number"),
  },
};

const baseConfig = {
  businessName: "Acme HVAC",
  faqKnowledgeBase: "Hours: 8 to 5 weekdays.",
  introFinetuneExamples: [],
};

describe("buildSnapshotFromCanonical", () => {
  it("extracts intro / FAQ / paths / data points from a generated single-path agent", () => {
    const { agent } = generateAgent(baseConfig, ["full_name", "phone_number"], undefined, TEST_DEFAULTS);
    const snap = buildSnapshotFromCanonical(agent as Record<string, unknown>);

    // Intro
    expect(snap.introNodeId).toBeDefined();
    expect(typeof snap.introPrompt).toBe("string");

    // FAQ
    expect(snap.faqNodeId).toBeDefined();
    // FAQ_PREFIX is stripped so the operator sees only the knowledge text.
    expect(snap.faqKnowledgeBase).toContain("Hours: 8 to 5 weekdays.");
    expect(snap.faqKnowledgeBase).not.toContain("Your goal is to answer");

    // Single default path
    expect(snap.paths).toHaveLength(1);
    const path = snap.paths[0];
    expect(path.name).toBe("Default");
    expect(path.transitionNodeId).toBeDefined();
    expect(path.dataPoints).toHaveLength(2);
    const names = path.dataPoints.map((d) => d.variableName);
    expect(names).toEqual(["full_name", "phone_number"]);
    for (const dp of path.dataPoints) {
      expect(dp.collectNodeId).toBeDefined();
      expect(typeof dp.conversationPrompt).toBe("string");
      expect(Array.isArray(dp.finetuneExamples)).toBe(true);
    }
  });

  it("exposes per-path entries when the generator builds a multi-path agent", () => {
    const { agent } = generateAgent(baseConfig, [], [
      { name: "Residential", transitionCondition: "Caller is residential", dataPoints: ["full_name"] },
      { name: "Commercial", transitionCondition: "Caller is commercial", dataPoints: ["phone_number"] },
    ], TEST_DEFAULTS);
    const snap = buildSnapshotFromCanonical(agent as Record<string, unknown>);
    expect(snap.paths.map((p) => p.name).sort()).toEqual(["Commercial", "Residential"]);
    const res = snap.paths.find((p) => p.name === "Residential")!;
    expect(res.dataPoints[0].variableName).toBe("full_name");
    const com = snap.paths.find((p) => p.name === "Commercial")!;
    expect(com.dataPoints[0].variableName).toBe("phone_number");
    // Each path should have a transition prompt resolved off the intro→path edge.
    expect(typeof res.transitionPrompt).toBe("string");
    expect(typeof com.transitionPrompt).toBe("string");
  });
});
