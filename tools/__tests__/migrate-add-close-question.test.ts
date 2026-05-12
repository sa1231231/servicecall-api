import { describe, it, expect } from "vitest";
import { migrateOneFlow } from "../migrate-add-close-question.js";

// Synthetic canonical conversation flows that exercise the four code paths
// of migrateOneFlow: skip-already, skip-no-close, skip-no-remarks, migrate.
//
// The migration script is a one-shot that will run against every live agent;
// any logic bug here propagates everywhere. These tests pin the pure
// mutation logic so future edits to the script can't accidentally regress
// idempotency / repointing / skip rules.

function makeFlow(nodes: any[], extra: Record<string, any> = {}): any {
  return { conversationFlow: { nodes, ...extra } };
}

const REMARKS = {
  id: "remarks-1",
  name: "Closing Remarks",
  type: "conversation",
  always_edge: { destination_node_id: "stmt-1", id: "ae-r-1", transition_condition: { type: "prompt", prompt: "Always" } },
};

describe("migrateOneFlow", () => {
  it("skips when conversationFlow is absent", () => {
    expect(migrateOneFlow({}).changed).toBe(false);
    expect(migrateOneFlow({}).reason).toBe("no conversationFlow");
  });

  it("skips when nodes array is absent", () => {
    const out = migrateOneFlow({ conversationFlow: {} });
    expect(out.changed).toBe(false);
    expect(out.reason).toBe("no nodes array");
  });

  it("is idempotent — skips when a Close Question already exists", () => {
    const flow = makeFlow([
      { id: "close-1", name: "Close", type: "conversation", always_edge: { destination_node_id: "cq-1", id: "ae", transition_condition: {} } },
      { id: "cq-1", name: "Close Question", type: "conversation", edges: [] },
      REMARKS,
    ]);
    const out = migrateOneFlow(flow);
    expect(out.changed).toBe(false);
    expect(out.reason).toBe("skipped-already");
    // Sanity: no new node added.
    expect(flow.conversationFlow.nodes.filter((n: any) => n.name === "Close Question")).toHaveLength(1);
  });

  it("skips when no Close node exists", () => {
    const flow = makeFlow([REMARKS]);
    const out = migrateOneFlow(flow);
    expect(out.changed).toBe(false);
    expect(out.reason).toBe("skipped-no-close");
  });

  it("skips when Closing Remarks is missing", () => {
    const flow = makeFlow([
      { id: "close-1", name: "Close", type: "conversation", always_edge: { destination_node_id: "remarks-1", id: "ae", transition_condition: {} } },
    ]);
    const out = migrateOneFlow(flow);
    expect(out.changed).toBe(false);
    expect(out.reason).toBe("skipped-no-remarks");
  });

  it("inserts Close Question + repoints single-path Close", () => {
    const close = {
      id: "close-1",
      name: "Close",
      type: "conversation",
      display_position: { x: 100, y: 894 },
      always_edge: {
        destination_node_id: "remarks-1",
        id: "ae-close-1",
        transition_condition: { type: "prompt", prompt: "Always" },
      },
    };
    const flow = makeFlow([close, REMARKS]);
    const out = migrateOneFlow(flow);
    expect(out.changed).toBe(true);
    expect(out.reason).toBe("migrated");
    expect(out.closeNodes).toBe(1);

    // New node was added.
    const cq = flow.conversationFlow.nodes.find((n: any) => n.name === "Close Question");
    expect(cq).toBeDefined();
    expect(cq.type).toBe("conversation");
    // Close → new node.
    expect(close.always_edge.destination_node_id).toBe(cq.id);
    // New node → Closing Remarks (via its single edge).
    expect(cq.edges).toHaveLength(1);
    expect(cq.edges[0].destination_node_id).toBe("remarks-1");
    expect(cq.edges[0].transition_condition.prompt).toBe(
      "The caller has no more questions",
    );
    // Inserted right after Close (cosmetic ordering check).
    const closeIdx = flow.conversationFlow.nodes.indexOf(close);
    expect(flow.conversationFlow.nodes[closeIdx + 1]).toBe(cq);
  });

  it("repoints every per-path Close node (multi-path) to the same new node", () => {
    const closeA = {
      id: "close-a", name: "Close (A)", type: "conversation",
      display_position: { x: 100, y: 894 },
      always_edge: { destination_node_id: "remarks-1", id: "ae-a", transition_condition: { type: "prompt", prompt: "Always" } },
    };
    const closeB = {
      id: "close-b", name: "Close (B)", type: "conversation",
      display_position: { x: 100, y: 2894 },
      always_edge: { destination_node_id: "remarks-1", id: "ae-b", transition_condition: { type: "prompt", prompt: "Always" } },
    };
    const flow = makeFlow([closeA, closeB, REMARKS]);
    const out = migrateOneFlow(flow);
    expect(out.changed).toBe(true);
    expect(out.closeNodes).toBe(2);

    const cq = flow.conversationFlow.nodes.find((n: any) => n.name === "Close Question");
    expect(cq).toBeDefined();
    expect(closeA.always_edge.destination_node_id).toBe(cq.id);
    expect(closeB.always_edge.destination_node_id).toBe(cq.id);
    // Both paths converge on the same new node (single Close Question for
    // the whole flow, not per-path).
    expect(closeA.always_edge.destination_node_id).toBe(
      closeB.always_edge.destination_node_id,
    );
  });

  it("safe-defaults position when reference Close has no display_position", () => {
    const close = {
      id: "close-1",
      name: "Close",
      type: "conversation",
      // no display_position — exercises the fallback path
      always_edge: { destination_node_id: "remarks-1", id: "ae", transition_condition: {} },
    };
    const flow = makeFlow([close, { ...REMARKS, display_position: { x: 200, y: 1182 } }]);
    const out = migrateOneFlow(flow);
    expect(out.changed).toBe(true);
    const cq = flow.conversationFlow.nodes.find((n: any) => n.name === "Close Question");
    expect(cq.display_position).toBeDefined();
    expect(typeof cq.display_position.x).toBe("number");
    expect(typeof cq.display_position.y).toBe("number");
  });
});
