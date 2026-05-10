// Maps an approved `proposed_change` onto a draft's `exportConfig`
// (CreateAgentBody). Phase 3 first cut: supports the kinds that map cleanly
// onto agent-level config fields. Pure function — caller persists.
//
// What's supported in this phase:
//   - add_faq_entry          → appends to `business.faqKnowledgeBase`
//   - edit_close_transition  → writes `business.pathClosePrompts[pathName]`
//                              (or `business.closePrompt` for global scope)
//
// What returns "not propagatable":
//   - edit_collect_prompt    → drafts often store data points as string refs
//                              into `data_point_defaults`; the prompt isn't
//                              owned by the draft in that case. Advisory.
//   - add_finetune_example   → same shape problem. Advisory.
//   - edit_router_branch     → advisory at the agent level too.
//   - split_data_point       → structural; advisory.
//
// "Not propagatable" doesn't fail the operator's approve action; it just
// means the agent gets the change and the draft does not. The route surfaces
// this in the response so the operator knows what bubbled up and what didn't.

import type { ProposedChange } from "./call-findings.js";
import type { CreateAgentBody } from "./agent-from-config.js";

export interface DraftApplyResult {
  ok: true;
  /** Mutated copy of the exportConfig — caller writes this back to Mongo. */
  next: CreateAgentBody;
  description: string;
}

export interface DraftApplyError {
  ok: false;
  /** True when the kind is structurally not propagatable to a draft. The
   *  approve flow treats this as a soft skip ("agent applied; draft skipped"),
   *  not a hard error. */
  notPropagatable?: boolean;
  error: string;
}

export type DraftApplyOutcome = DraftApplyResult | DraftApplyError;

// ── Public API ──────────────────────────────────────────────────────────────

export function applyToDraft(
  proposed: ProposedChange,
  exportConfig: CreateAgentBody,
): DraftApplyOutcome {
  switch (proposed.kind) {
    case "add_faq_entry":
      return applyAddFaqEntry(proposed, exportConfig);
    case "edit_close_prompt":
    case "edit_close_transition":
      return applyEditCloseTransition(proposed, exportConfig);
    case "edit_intro_transition":
      return applyEditIntroTransition(proposed, exportConfig);
    case "add_intro_finetune":
      return applyAddIntroFinetune(proposed, exportConfig);
    case "edit_global_prompt":
      return {
        ok: false,
        notPropagatable: true,
        error:
          "Global prompt is regenerated from businessName template at agent build time — drafts don't carry an override. Agent was updated; future agents will use the default template.",
      };
    case "edit_intro_prompt":
      return {
        ok: false,
        notPropagatable: true,
        error:
          "Intro prompt is regenerated from the businessName template at agent build time — drafts don't carry an override. Agent was updated; future agents will use the default.",
      };
    case "edit_collect_prompt":
      return {
        ok: false,
        notPropagatable: true,
        error:
          "Collect-prompt edits don't propagate to the draft because data points are stored as template refs. Future agents won't inherit; the agent itself was updated.",
      };
    case "add_collect_finetune":
    case "add_finetune_example":
      return {
        ok: false,
        notPropagatable: true,
        error:
          "Collect-node finetune examples don't propagate to the draft because data points are stored as template refs. Future agents won't inherit; the agent itself was updated.",
      };
    case "edit_router_branch":
      return {
        ok: false,
        notPropagatable: true,
        error: "Router branch conditions are advisory — drafts don't carry router overrides.",
      };
    case "split_data_point":
      return {
        ok: false,
        notPropagatable: true,
        error: "Splitting a data point is structural — drafts can't auto-apply.",
      };
    default:
      return { ok: false, error: `Unsupported proposed_change kind: ${String(proposed.kind)}` };
  }
}

// ── Per-kind handlers ───────────────────────────────────────────────────────

function applyAddFaqEntry(
  proposed: ProposedChange,
  exportConfig: CreateAgentBody,
): DraftApplyOutcome {
  const entry = readString(proposed.payload.entry);
  if (!entry) return { ok: false, error: "add_faq_entry: payload.entry must be a non-empty string" };

  const current = exportConfig.business?.faqKnowledgeBase ?? "";
  if (current.includes(entry.trim())) {
    return { ok: false, error: "Draft FAQ already contains this entry — skipping." };
  }

  const merged = current.trim() ? `${current.trim()}\n\n${entry.trim()}` : entry.trim();
  const next: CreateAgentBody = {
    ...exportConfig,
    business: { ...exportConfig.business, faqKnowledgeBase: merged },
  };
  return {
    ok: true,
    next,
    description: `Append FAQ entry to draft: ${truncate(entry, 80)}`,
  };
}

function applyEditCloseTransition(
  proposed: ProposedChange,
  exportConfig: CreateAgentBody,
): DraftApplyOutcome {
  const append = readString(proposed.payload.append);
  if (!append) {
    return { ok: false, error: "edit_close_transition: payload.append must be a non-empty string" };
  }
  const pathName = proposed.target_path_name;

  // Two scopes the draft supports:
  //   - per-path:  business.pathClosePrompts[pathName]
  //   - global:    business.closePrompt
  // We only touch the one matching the proposed change's target.
  if (pathName) {
    const existingPathMap = exportConfig.business?.pathClosePrompts ?? {};
    const current = existingPathMap[pathName] ?? exportConfig.business?.closePrompt ?? "";
    if (current.includes(append.trim())) {
      return { ok: false, error: "Draft close prompt already contains this addition — skipping." };
    }
    const merged = current.trim() ? `${current.trim()}\n\n${append.trim()}` : append.trim();
    const nextPathMap = { ...existingPathMap, [pathName]: merged };
    const next: CreateAgentBody = {
      ...exportConfig,
      business: {
        ...exportConfig.business,
        pathClosePrompts: nextPathMap,
      },
    };
    return {
      ok: true,
      next,
      description: `Append to ${pathName} close prompt in draft: ${truncate(append, 80)}`,
    };
  }

  // Global close prompt fallback.
  const current = exportConfig.business?.closePrompt ?? "";
  if (current.includes(append.trim())) {
    return { ok: false, error: "Draft close prompt already contains this addition — skipping." };
  }
  const merged = current.trim() ? `${current.trim()}\n\n${append.trim()}` : append.trim();
  const next: CreateAgentBody = {
    ...exportConfig,
    business: { ...exportConfig.business, closePrompt: merged },
  };
  return {
    ok: true,
    next,
    description: `Append to global close prompt in draft: ${truncate(append, 80)}`,
  };
}

function applyEditIntroTransition(
  proposed: ProposedChange,
  exportConfig: CreateAgentBody,
): DraftApplyOutcome {
  const append = readString(proposed.payload.append);
  if (!append) return { ok: false, error: "edit_intro_transition: payload.append must be a non-empty string" };
  const pathName = proposed.target_path_name;
  if (!pathName) return { ok: false, error: "edit_intro_transition requires target_path_name" };

  const paths = exportConfig.paths ?? [];
  const targetIdx = paths.findIndex((p) => p.name === pathName);
  if (targetIdx < 0) {
    return {
      ok: false,
      notPropagatable: true,
      error: `Path "${pathName}" not found on draft — single-path drafts don't carry per-path transition conditions.`,
    };
  }

  const current = paths[targetIdx].transitionCondition ?? "";
  if (current.includes(append.trim())) {
    return { ok: false, error: "Draft routing condition already contains this addition — skipping." };
  }
  const merged = current.trim() ? `${current.trim()}\n\n${append.trim()}` : append.trim();
  const nextPaths = paths.map((p, i) => (i === targetIdx ? { ...p, transitionCondition: merged } : p));
  const next: CreateAgentBody = { ...exportConfig, paths: nextPaths };
  return {
    ok: true,
    next,
    description: `Append to ${pathName} routing condition in draft: ${truncate(append, 80)}`,
  };
}

function applyAddIntroFinetune(
  proposed: ProposedChange,
  exportConfig: CreateAgentBody,
): DraftApplyOutcome {
  const userTurn = readString(proposed.payload.user);
  const agentTurn = readString(proposed.payload.agent);
  if (!userTurn || !agentTurn) {
    return { ok: false, error: "add_intro_finetune: payload.user and payload.agent must both be non-empty strings" };
  }
  const routesTo = readString(proposed.payload.routes_to) ?? "negative";
  if (routesTo === "faq" || routesTo === "negative") {
    // FAQ-routed and negative examples don't ride the per-path bucket.
    // The draft schema doesn't carry agent-level intro examples directly —
    // those are reconstructed each build from a default. Mark advisory.
    return {
      ok: false,
      notPropagatable: true,
      error:
        "Intro finetune examples that route to FAQ or are negative don't have a draft-level home. Agent was updated; future agents will need the example added by hand.",
    };
  }

  // Path-routed example: lives under paths[i].transitionFinetuneExamples.
  const paths = exportConfig.paths ?? [];
  const targetIdx = paths.findIndex((p) => p.name === routesTo);
  if (targetIdx < 0) {
    return {
      ok: false,
      notPropagatable: true,
      error: `Path "${routesTo}" not found on draft — cannot store the example.`,
    };
  }
  const newTranscript = [
    { content: userTurn, role: "user" as const },
    { content: agentTurn, role: "agent" as const },
  ];
  const existing = paths[targetIdx].transitionFinetuneExamples ?? [];
  const equivalent = existing.some(
    (ex) =>
      Array.isArray(ex.transcript) &&
      ex.transcript.length === newTranscript.length &&
      ex.transcript.every((t, i) => t.role === newTranscript[i].role && t.content === newTranscript[i].content),
  );
  if (equivalent) {
    return { ok: false, error: "Draft already has an equivalent example on this path." };
  }
  const newExample = { transcript: newTranscript, type: "positive" as const };
  const nextPaths = paths.map((p, i) =>
    i === targetIdx
      ? {
          ...p,
          transitionFinetuneExamples: [
            ...(p.transitionFinetuneExamples ?? []),
            newExample,
          ],
        }
      : p,
  );
  const next: CreateAgentBody = { ...exportConfig, paths: nextPaths };
  return {
    ok: true,
    next,
    description: `Add intro finetune routing to "${routesTo}" in draft: ${truncate(userTurn, 50)}`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
