import { describe, it, expect } from "vitest";
import { parseConversationFlow } from "../node-parser.js";
// These tests cover edge cases not exercised by node-editor.test.ts
// (which uses full Demo Meter / generated fixtures).
// ── Minimal valid flow builder ─────────────────────────────────────────────
function buildMinimalFlow(extraNodes = [], overrides = {}) {
    // Construct a flow with intro + transition + extract + router + collect + confirm
    // matching the parser's expectations. This produces one parseable path.
    return {
        conversationFlow: {
            start_node_id: "intro",
            global_prompt: "global",
            nodes: [
                { id: "intro", type: "conversation", name: "Intro", instruction: { type: "prompt", text: "hi" }, edges: [] },
                {
                    id: "transition",
                    type: "conversation",
                    name: "Transition (path_a)",
                    skip_response_edge: { destination_node_id: "extract" },
                },
                {
                    id: "extract",
                    type: "extract_dynamic_variables",
                    name: "Extract All Variables (path_a)",
                    variables: [{ name: "full_name", type: "string", description: "" }],
                    else_edge: { destination_node_id: "router" },
                },
                {
                    id: "router",
                    type: "branch",
                    name: "Variables Router (path_a)",
                    edges: [
                        {
                            destination_node_id: "collect",
                            transition_condition: { type: "equation", equations: [] },
                        },
                    ],
                    else_edge: { destination_node_id: "close" },
                },
                {
                    id: "collect",
                    type: "conversation",
                    name: "Collect Full Name",
                    instruction: { type: "prompt", text: "Ask for name" },
                    edges: [
                        {
                            destination_node_id: "confirm",
                            transition_condition: { type: "prompt", prompt: "Got name" },
                        },
                    ],
                },
                {
                    id: "confirm",
                    type: "extract_dynamic_variables",
                    name: "Confirm Full Name",
                    variables: [{ name: "full_name", type: "string", description: "" }],
                },
                { id: "close", type: "conversation", name: "Close", instruction: { type: "prompt", text: "bye" } },
                ...extraNodes,
            ],
            ...overrides,
        },
    };
}
// ── Top-level guards ────────────────────────────────────────────────────────
describe("parseConversationFlow — guards", () => {
    it("throws when conversationFlow is missing from canonical JSON", () => {
        expect(() => parseConversationFlow({})).toThrow(/Missing conversationFlow/);
    });
    it("throws when nodes array is missing", () => {
        expect(() => parseConversationFlow({ conversationFlow: { start_node_id: "x" } })).toThrow(/No nodes/);
    });
    it("throws when nodes is empty", () => {
        expect(() => parseConversationFlow({ conversationFlow: { start_node_id: "x", nodes: [] } })).toThrow(/No nodes/);
    });
    it("throws when start_node_id does not match any node", () => {
        expect(() => parseConversationFlow({
            conversationFlow: {
                start_node_id: "missing_id",
                nodes: [{ id: "other", type: "conversation" }],
            },
        })).toThrow(/Start node missing_id not found/);
    });
});
// ── Happy path basics ───────────────────────────────────────────────────────
describe("parseConversationFlow — minimal flow", () => {
    it("parses intro, paths, close, FAQ, closing nodes", () => {
        const result = parseConversationFlow(buildMinimalFlow());
        expect(result.introNode.id).toBe("intro");
        expect(result.startNodeId).toBe("intro");
        expect(result.globalPrompt).toBe("global");
        expect(result.closeNode?.id).toBe("close");
        expect(result.paths).toHaveLength(1);
        expect(result.paths[0].name).toBe("path_a");
        expect(result.paths[0].endMode).toBe("callback");
    });
    it("returns empty closingNodes when there are no Closing Remarks/Statement nodes", () => {
        const result = parseConversationFlow(buildMinimalFlow());
        expect(result.closingNodes).toEqual([]);
    });
    it("includes Closing Remarks and Closing Statement when present", () => {
        const result = parseConversationFlow(buildMinimalFlow([
            { id: "cr", type: "conversation", name: "Closing Remarks" },
            { id: "cs", type: "conversation", name: "Closing Statement" },
        ]));
        expect(result.closingNodes).toHaveLength(2);
    });
    it("collects globalNodes (those with global_node_setting)", () => {
        const result = parseConversationFlow(buildMinimalFlow([
            { id: "g1", type: "conversation", name: "Global", global_node_setting: { name: "g" } },
        ]));
        expect(result.globalNodes).toHaveLength(1);
        expect(result.globalNodes[0].id).toBe("g1");
    });
    it("finds Admin/FAQ when present", () => {
        const result = parseConversationFlow(buildMinimalFlow([
            { id: "faq", type: "conversation", name: "Admin/FAQ" },
        ]));
        expect(result.faqNode?.id).toBe("faq");
    });
    it("faqNode is null when no Admin/FAQ", () => {
        const result = parseConversationFlow(buildMinimalFlow());
        expect(result.faqNode).toBeNull();
    });
    it("closeNode is null when no Close node", () => {
        const flow = buildMinimalFlow();
        flow.conversationFlow.nodes = flow.conversationFlow.nodes.filter((n) => n.name !== "Close");
        const result = parseConversationFlow(flow);
        expect(result.closeNode).toBeNull();
    });
});
// ── End-mode detection ─────────────────────────────────────────────────────
describe("parseConversationFlow — end-mode detection", () => {
    it("detects transfer end mode when router else_edge points directly to transfer_call", () => {
        const flow = buildMinimalFlow([
            {
                id: "transfer",
                type: "transfer_call",
                name: "Transfer Call (path_a)",
                transfer_destination: { type: "predefined", number: "+15558888888" },
            },
        ]);
        // Repoint router's else_edge to the transfer node
        flow.conversationFlow.nodes.find((n) => n.id === "router").else_edge = {
            destination_node_id: "transfer",
        };
        const result = parseConversationFlow(flow);
        expect(result.paths[0].endMode).toBe("transfer");
        expect(result.paths[0].transferCallNode?.id).toBe("transfer");
        expect(result.paths[0].transferDestination).toBe("+15558888888");
    });
    it("detects transfer end mode via Pre-Transfer node + always_edge to transfer_call", () => {
        const flow = buildMinimalFlow([
            {
                id: "pre",
                name: "Pre-Transfer (path_a)",
                type: "conversation",
                always_edge: { destination_node_id: "transfer" },
            },
            {
                id: "transfer",
                type: "transfer_call",
                name: "Transfer Call (path_a)",
                transfer_destination: { type: "predefined", number: "+15559999999" },
            },
        ]);
        flow.conversationFlow.nodes.find((n) => n.id === "router").else_edge = {
            destination_node_id: "pre",
        };
        const result = parseConversationFlow(flow);
        expect(result.paths[0].endMode).toBe("transfer");
        expect(result.paths[0].preTransferNode?.id).toBe("pre");
        expect(result.paths[0].transferCallNode?.id).toBe("transfer");
        expect(result.paths[0].transferDestination).toBe("+15559999999");
    });
    it("does NOT set transferDestination when number is a {{template}}", () => {
        const flow = buildMinimalFlow([
            {
                id: "transfer",
                type: "transfer_call",
                name: "Transfer Call (path_a)",
                transfer_destination: { type: "predefined", number: "{{dispatch_call_number}}" },
            },
        ]);
        flow.conversationFlow.nodes.find((n) => n.id === "router").else_edge = {
            destination_node_id: "transfer",
        };
        const result = parseConversationFlow(flow);
        expect(result.paths[0].endMode).toBe("transfer");
        expect(result.paths[0].transferDestination).toBeUndefined();
    });
    it("callback mode when terminal is the Close node", () => {
        const result = parseConversationFlow(buildMinimalFlow());
        expect(result.paths[0].endMode).toBe("callback");
        expect(result.paths[0].preTransferNode).toBeUndefined();
        expect(result.paths[0].transferCallNode).toBeUndefined();
    });
});
// ── Router edge robustness ─────────────────────────────────────────────────
describe("parseConversationFlow — router edge robustness", () => {
    it("skips router edges pointing to non-existent nodes", () => {
        const flow = buildMinimalFlow();
        const router = flow.conversationFlow.nodes.find((n) => n.id === "router");
        router.edges.push({
            destination_node_id: "ghost", // doesn't exist
            transition_condition: { type: "equation", equations: [] },
        });
        const result = parseConversationFlow(flow);
        // Still parses the legit data point; ghost edge silently skipped.
        expect(result.paths[0].dataChain).toHaveLength(1);
        expect(result.paths[0].dataChain[0].variableName).toBe("full_name");
    });
    it("skips router edges pointing to non-conversation nodes", () => {
        const flow = buildMinimalFlow([
            { id: "weird", type: "extract_dynamic_variables", name: "Weird Extract" },
        ]);
        const router = flow.conversationFlow.nodes.find((n) => n.id === "router");
        router.edges.push({
            destination_node_id: "weird",
            transition_condition: { type: "equation", equations: [] },
        });
        const result = parseConversationFlow(flow);
        expect(result.paths[0].dataChain).toHaveLength(1);
    });
    it("skips when collect node has no edges", () => {
        const flow = buildMinimalFlow([
            {
                id: "collect2",
                type: "conversation",
                name: "Collect City",
                instruction: { type: "prompt", text: "" },
                edges: [], // empty edges
            },
        ]);
        const router = flow.conversationFlow.nodes.find((n) => n.id === "router");
        router.edges.push({
            destination_node_id: "collect2",
            transition_condition: { type: "equation", equations: [] },
        });
        const result = parseConversationFlow(flow);
        expect(result.paths[0].dataChain).toHaveLength(1); // still just full_name
    });
    it("skips when confirm node is not extract_dynamic_variables", () => {
        const flow = buildMinimalFlow([
            {
                id: "collect2",
                type: "conversation",
                name: "Collect City",
                instruction: { type: "prompt", text: "" },
                edges: [{ destination_node_id: "wrong_type", transition_condition: {} }],
            },
            { id: "wrong_type", type: "conversation", name: "Wrong Type" },
        ]);
        const router = flow.conversationFlow.nodes.find((n) => n.id === "router");
        router.edges.push({
            destination_node_id: "collect2",
            transition_condition: { type: "equation", equations: [] },
        });
        const result = parseConversationFlow(flow);
        expect(result.paths[0].dataChain).toHaveLength(1);
    });
});
// ── Orphan data points ──────────────────────────────────────────────────────
describe("parseConversationFlow — orphan data points", () => {
    it("flags variables present in front-extract but missing from data chain as orphans", () => {
        const flow = buildMinimalFlow();
        // Add a variable to the extract node that has no corresponding collect node
        const extract = flow.conversationFlow.nodes.find((n) => n.id === "extract");
        extract.variables.push({ name: "is_loaded", type: "boolean", description: "" });
        const result = parseConversationFlow(flow);
        const orphans = result.paths[0].dataChain.filter((dp) => dp.orphan);
        expect(orphans).toHaveLength(1);
        expect(orphans[0].variableName).toBe("is_loaded");
    });
    it("does NOT flag _path_taken as an orphan", () => {
        const flow = buildMinimalFlow();
        const extract = flow.conversationFlow.nodes.find((n) => n.id === "extract");
        extract.variables.push({ name: "_path_taken", type: "string", description: "" });
        const result = parseConversationFlow(flow);
        expect(result.paths[0].dataChain.some((dp) => dp.variableName === "_path_taken")).toBe(false);
    });
    it("does NOT flag *_collected sentinel variables as orphans", () => {
        const flow = buildMinimalFlow();
        const extract = flow.conversationFlow.nodes.find((n) => n.id === "extract");
        extract.variables.push({ name: "phone_number_collected", type: "boolean", description: "" });
        const result = parseConversationFlow(flow);
        expect(result.paths[0].dataChain.some((dp) => dp.variableName === "phone_number_collected")).toBe(false);
    });
    it("orphan default label humanizes the variable name", () => {
        const flow = buildMinimalFlow();
        const extract = flow.conversationFlow.nodes.find((n) => n.id === "extract");
        extract.variables.push({ name: "truck_number", type: "string", description: "" });
        const result = parseConversationFlow(flow);
        const orphan = result.paths[0].dataChain.find((dp) => dp.orphan);
        expect(orphan?.label).toBe("Truck Number");
    });
});
// ── No paths found (degenerate flow) ────────────────────────────────────────
describe("parseConversationFlow — no paths found", () => {
    it("returns empty paths array when there are no Extract All Variables nodes", () => {
        const result = parseConversationFlow({
            conversationFlow: {
                start_node_id: "intro",
                nodes: [
                    { id: "intro", type: "conversation", name: "Intro" },
                ],
            },
        });
        expect(result.paths).toEqual([]);
    });
    it("ignores extract node when transition can't be matched and no fallback transition exists", () => {
        // Extract node references no else_edge (so router lookup fails) AND no
        // transition node skip-edges to it AND no fallback transition with the
        // same suffix → path is dropped.
        const result = parseConversationFlow({
            conversationFlow: {
                start_node_id: "intro",
                nodes: [
                    { id: "intro", type: "conversation", name: "Intro" },
                    {
                        id: "extract_orphan",
                        type: "extract_dynamic_variables",
                        name: "Extract All Variables (orphan_path)",
                        // no else_edge → router not found via primary lookup
                        // no fallback router with matching suffix exists either
                    },
                ],
            },
        });
        expect(result.paths).toEqual([]);
    });
});
// ── Fallback path matching ─────────────────────────────────────────────────
describe("parseConversationFlow — fallback path matching", () => {
    it("matches transition + router by path suffix when primary lookup fails", () => {
        // Setup: extract node has no else_edge, transition has no skip_response_edge.
        // Both transition and router share the same path suffix → fallback matching
        // by suffix should kick in.
        const result = parseConversationFlow({
            conversationFlow: {
                start_node_id: "intro",
                nodes: [
                    { id: "intro", type: "conversation", name: "Intro" },
                    {
                        id: "transition",
                        type: "conversation",
                        name: "Transition (fallback_path)",
                        // no skip_response_edge — primary lookup fails
                    },
                    {
                        id: "extract",
                        type: "extract_dynamic_variables",
                        name: "Extract All Variables (fallback_path)",
                        variables: [],
                        // no else_edge — primary lookup fails
                    },
                    {
                        id: "router",
                        type: "branch",
                        name: "Variables Router (fallback_path)",
                        edges: [],
                    },
                ],
            },
        });
        expect(result.paths).toHaveLength(1);
        expect(result.paths[0].name).toBe("fallback_path");
        expect(result.paths[0].transitionNode.id).toBe("transition");
        expect(result.paths[0].routerNode.id).toBe("router");
    });
    it("falls back to default Conversation/Variables Router when no path suffix", () => {
        // Single-path canonical: "Extract All Variables" (no suffix), "Conversation",
        // "Variables Router" (no suffixes). Primary lookups fail → falls back to
        // the default-named transition + router.
        const result = parseConversationFlow({
            conversationFlow: {
                start_node_id: "intro",
                nodes: [
                    { id: "intro", type: "conversation", name: "Intro" },
                    { id: "transition", type: "conversation", name: "Conversation" },
                    {
                        id: "extract",
                        type: "extract_dynamic_variables",
                        name: "Extract All Variables",
                        variables: [],
                    },
                    { id: "router", type: "branch", name: "Variables Router", edges: [] },
                ],
            },
        });
        expect(result.paths).toHaveLength(1);
        expect(result.paths[0].name).toBe("Default");
    });
    it("rebuilds paths from router nodes when no Extract All Variables nodes exist", () => {
        // No Extract All Variables nodes at all — secondary fallback path uses
        // routerNodes alone to construct paths.
        const result = parseConversationFlow({
            conversationFlow: {
                start_node_id: "intro",
                nodes: [
                    { id: "intro", type: "conversation", name: "Intro" },
                    { id: "trans", type: "conversation", name: "Transition (legacy_path)" },
                    { id: "router", type: "branch", name: "Variables Router (legacy_path)", edges: [] },
                    // Even though we have no extract-all node, we DO need an extract for
                    // pathConfig matching; legacy flows had a pseudo-extract per path.
                    // But this branch only triggers with NO extract nodes anywhere.
                ],
            },
        });
        // With no Extract All Variables nodes anywhere, the router-based fallback
        // tries to find an extract — there's none — so this path is dropped too.
        // This still exercises the lines 211-223 branch.
        expect(result.paths).toEqual([]);
    });
});
// ── Edge cases in orphan + parseDataPointFromNodes ─────────────────────────
describe("parseConversationFlow — small edge cases", () => {
    it("ignores front-extract variables that have no name", () => {
        // Touches line 319: `if (!name) continue;` in orphan detection
        const flow = buildMinimalFlow();
        const extract = flow.conversationFlow.nodes.find((n) => n.id === "extract");
        extract.variables.push({ type: "string", description: "no name field" });
        const result = parseConversationFlow(flow);
        // Should still parse cleanly with one path; nameless var silently dropped.
        expect(result.paths).toHaveLength(1);
        const orphans = result.paths[0].dataChain.filter((dp) => dp.orphan);
        expect(orphans).toHaveLength(0);
    });
    it("skips a router edge whose confirm node has empty variables array", () => {
        // Touches line 361: `if (!Array.isArray(confirmVars) || confirmVars.length === 0) return null;`
        const flow = buildMinimalFlow([
            {
                id: "collect2",
                type: "conversation",
                name: "Collect Bogus",
                instruction: { type: "prompt", text: "" },
                edges: [{ destination_node_id: "confirm2", transition_condition: {} }],
            },
            {
                id: "confirm2",
                type: "extract_dynamic_variables",
                name: "Confirm Bogus",
                variables: [], // empty → parseDataPointFromNodes returns null
            },
        ]);
        const router = flow.conversationFlow.nodes.find((n) => n.id === "router");
        router.edges.push({
            destination_node_id: "collect2",
            transition_condition: { type: "equation", equations: [] },
        });
        const result = parseConversationFlow(flow);
        // Only the original full_name data point parses; collect2/confirm2 dropped.
        expect(result.paths[0].dataChain).toHaveLength(1);
        expect(result.paths[0].dataChain[0].variableName).toBe("full_name");
    });
});
