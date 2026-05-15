import { describe, it, expect } from "vitest";
import {
  generateAgent,
  NOT_MENTIONED,
  CALLER_DOESNT_KNOW,
  defaultExtractEquation,
  type DataPoint,
} from "../agent-generator/index.js";

// ── Why this file exists ─────────────────────────────────────────────────────
//
// agent-generator.test.ts holds many fine-grained assertions (this prompt
// equals X, this node has Y edges). They catch what they assert. This file
// adds a complementary lock: a *full structural snapshot* of the canonical
// JSON that comes out of generateAgent() for two fixed configs.
//
// Any future change to node-builders or generate-agent that alters the
// generated shape — adding a node, repointing an edge, tweaking a default
// prompt, changing the order of nodes — will surface as a snapshot diff.
// The dev either updates the snapshot intentionally (vitest -u) or fixes
// the regression.
//
// Sanitization rule: replace generated IDs with the node's NAME so the
// snapshot is stable across runs (IDs include Date.now()/Math.random()).
// We also drop display_position (visual layout, irrelevant for behavior)
// and any *_id field that's pure noise. Edges become `name → name`
// strings so the wiring is human-readable in the diff.

const baseConfig = {
  businessName: "Snapshot Co",
  faqKnowledgeBase: "Snapshot FAQ knowledge base for testing.",
  introFinetuneExamples: [],
};

const TEST_DEFAULTS: Record<string, DataPoint> = {
  full_name: {
    label: "Full Name",
    variableName: "full_name",
    type: "string",
    description: `Full name. If not mentioned, set to "${NOT_MENTIONED}". If they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: "Ask for the caller's name. If they don't know, move on.",
    forwardCondition: "The caller has given their name or indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("full_name"),
  },
  city: {
    label: "City",
    variableName: "city",
    type: "string",
    description: `City. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for the city.",
    forwardCondition: "The caller has given their city",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("city"),
  },
};

// ── Sanitizer ─────────────────────────────────────────────────────────────

/** Build a map from generated node id → node name. */
function buildIdNameMap(nodes: any[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of nodes) if (n.id && n.name) out.set(n.id, n.name);
  return out;
}

/** Replace any generated id-like value with the node's name for stability. */
function nameify(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value !== "string") return value;
  return idMap.get(value) ?? value;
}

/** Generated IDs match these prefixes — drop them at any depth so the
 *  snapshot is stable across runs. */
const GENERATED_ID_PREFIXES = ["node-", "edge-", "go-back-", "always-edge-", "skip-response-edge-"];
function looksGenerated(s: unknown): boolean {
  return typeof s === "string" && GENERATED_ID_PREFIXES.some((p) => s.startsWith(p));
}

function sanitize(value: any, idMap: Map<string, string>): any {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, idMap));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Drop pure-noise fields that change every run.
    if (k === "display_position") continue;
    if (k === "id" && looksGenerated(v)) continue;
    // Replace destination_node_id with the target's name for readability.
    if (k === "destination_node_id" && typeof v === "string") {
      out[k] = idMap.get(v) ?? v;
      continue;
    }
    // Per-key edge sanitization — turn the cluttered edge object into a
    // string "→ <name> (condition)" so the snapshot reads like a wiring
    // diagram instead of a wall of IDs.
    if (k === "always_edge" && v && typeof v === "object") {
      const dest = nameify((v as any).destination_node_id, idMap);
      const cond = (v as any).transition_condition?.prompt ?? "?";
      out[k] = `→ ${dest} (${cond})`;
      continue;
    }
    if (k === "skip_response_edge" && v && typeof v === "object") {
      const dest = nameify((v as any).destination_node_id, idMap);
      out[k] = `→ ${dest} (skip)`;
      continue;
    }
    if (k === "else_edge" && v && typeof v === "object") {
      const dest = nameify((v as any).destination_node_id, idMap);
      out[k] = `→ ${dest} (else)`;
      continue;
    }
    if (k === "edges" && Array.isArray(v)) {
      out[k] = v.map((e: any) => {
        const dest = nameify(e.destination_node_id, idMap);
        const cond = e.transition_condition?.prompt
          ?? (e.transition_condition?.type === "equation" ? "equation" : "?");
        return `→ ${dest} (${cond})`;
      });
      continue;
    }
    if (
      (k === "finetune_transition_examples" || k === "finetune_conversation_examples") &&
      Array.isArray(v)
    ) {
      // Examples carry generated IDs + can be re-ordered on re-export;
      // keep only the count to lock in coverage without snapshot churn.
      out[k] = `[${v.length} examples]`;
      continue;
    }
    out[k] = sanitize(v, idMap);
  }
  return out;
}

function snapshotFlow(agent: any): any[] {
  const nodes = (agent.conversationFlow as any).nodes as any[];
  const idMap = buildIdNameMap(nodes);
  return nodes
    .map((n) => sanitize(n, idMap))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("agent-generator canonical JSON snapshot", () => {
  it("single-path agent: stable shape lock", () => {
    const { agent } = generateAgent(
      baseConfig,
      ["full_name", "city"],
      undefined,
      TEST_DEFAULTS,
    );
    expect(snapshotFlow(agent)).toMatchSnapshot();
  });

  it("multi-path agent: stable shape lock (one callback, one transfer)", () => {
    const { agent } = generateAgent(
      baseConfig,
      [],
      [
        { name: "Callback", transitionCondition: "Wants callback", dataPoints: ["full_name"] },
        {
          name: "Transfer",
          transitionCondition: "Wants live transfer",
          dataPoints: ["city"],
          endMode: "transfer" as const,
          transferDestination: "+15555555555",
        },
      ],
      TEST_DEFAULTS,
    );
    expect(snapshotFlow(agent)).toMatchSnapshot();
  });
});
