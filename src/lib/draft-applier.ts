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
    case "edit_close_transition":
      return applyEditCloseTransition(proposed, exportConfig);
    case "edit_collect_prompt":
      return {
        ok: false,
        notPropagatable: true,
        error:
          "Collect-prompt edits don't propagate to the draft because data points are stored as template refs. Future agents won't inherit; the agent itself was updated.",
      };
    case "add_finetune_example":
      return {
        ok: false,
        notPropagatable: true,
        error:
          "Fine-tune examples don't propagate to the draft because data points are stored as template refs. Future agents won't inherit; the agent itself was updated.",
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
