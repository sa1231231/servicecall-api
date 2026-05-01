import { describe, it, expect, vi } from "vitest";
import { extractFlowParams, extractAgentParams, extractVariables, pushFlowToRetell, fetchRetellAgent, } from "../retell-sync.js";
// ── extractFlowParams ────────────────────────────────────────────────────────
describe("extractFlowParams", () => {
    it("strips flow metadata keys", () => {
        const flow = {
            conversation_flow_id: "cf_123",
            version: 3,
            is_published: true,
            flex_mode: false,
            is_transfer_cf: false,
            global_prompt: "You are a helpful agent.",
            start_node_id: "node-1",
            nodes: [{ id: "node-1", type: "conversation" }],
            model_choice: { type: "cascading", model: "gpt-4.1" },
        };
        const params = extractFlowParams(flow);
        expect(params).not.toHaveProperty("conversation_flow_id");
        expect(params).not.toHaveProperty("version");
        expect(params).not.toHaveProperty("is_published");
        expect(params).not.toHaveProperty("flex_mode");
        expect(params).not.toHaveProperty("is_transfer_cf");
        expect(params.global_prompt).toBe("You are a helpful agent.");
        expect(params.start_node_id).toBe("node-1");
        expect(params.nodes).toEqual([{ id: "node-1", type: "conversation" }]);
        expect(params.model_choice).toEqual({ type: "cascading", model: "gpt-4.1" });
    });
    it("passes through unknown keys", () => {
        const flow = { some_new_field: "value", version: 1 };
        const params = extractFlowParams(flow);
        expect(params.some_new_field).toBe("value");
        expect(params).not.toHaveProperty("version");
    });
    it("handles empty object", () => {
        expect(extractFlowParams({})).toEqual({});
    });
});
// ── extractAgentParams ───────────────────────────────────────────────────────
describe("extractAgentParams", () => {
    it("strips agent metadata keys and sets response_engine", () => {
        const agent = {
            agent_id: "agent_123",
            channel: "voice",
            last_modification_timestamp: 1234567890,
            version: 2,
            is_published: true,
            version_title: "v2",
            conversationFlow: { nodes: [] },
            response_engine: { type: "conversation-flow", version: 1 },
            agent_name: "Test Agent",
            voice_id: "fish_audio-Kate",
            webhook_url: "https://example.com/hook",
        };
        const params = extractAgentParams(agent, "cf_456");
        expect(params).not.toHaveProperty("agent_id");
        expect(params).not.toHaveProperty("channel");
        expect(params).not.toHaveProperty("last_modification_timestamp");
        expect(params).not.toHaveProperty("version");
        expect(params).not.toHaveProperty("is_published");
        expect(params).not.toHaveProperty("version_title");
        expect(params).not.toHaveProperty("conversationFlow");
        expect(params.agent_name).toBe("Test Agent");
        expect(params.voice_id).toBe("fish_audio-Kate");
        expect(params.webhook_url).toBe("https://example.com/hook");
        expect(params.response_engine).toEqual({
            type: "conversation-flow",
            conversation_flow_id: "cf_456",
        });
    });
    it("handles minimal object", () => {
        const params = extractAgentParams({}, "cf_789");
        expect(params.response_engine).toEqual({
            type: "conversation-flow",
            conversation_flow_id: "cf_789",
        });
    });
});
// ── extractVariables ─────────────────────────────────────────────────────────
describe("extractVariables", () => {
    it("extracts from 'Extract All Variables' node", () => {
        const json = {
            conversationFlow: {
                nodes: [
                    {
                        name: "Extract All Variables",
                        type: "extract_dynamic_variables",
                        variables: [
                            { name: "full_name", type: "string", description: "Name" },
                            { name: "phone_number", type: "string", description: "Phone" },
                            { name: "city", type: "string", description: "City" },
                        ],
                    },
                    {
                        name: "Confirm Full Name",
                        type: "extract_dynamic_variables",
                        variables: [
                            { name: "full_name", type: "string", description: "Name" },
                        ],
                    },
                ],
            },
        };
        const vars = extractVariables(json);
        expect(vars).toEqual([
            { key: "full_name", label: "Name" },
            { key: "phone_number", label: "Phone" },
            { key: "city", label: "City" },
        ]);
    });
    it("filters out phone_number_collected", () => {
        const json = {
            conversationFlow: {
                nodes: [
                    {
                        name: "Extract All Variables",
                        type: "extract_dynamic_variables",
                        variables: [
                            { name: "full_name", type: "string" },
                            { name: "phone_number_collected", type: "boolean" },
                        ],
                    },
                ],
            },
        };
        const vars = extractVariables(json);
        expect(vars).toHaveLength(1);
        expect(vars[0].key).toBe("full_name");
    });
    it("falls back to collecting from all extract nodes when no 'Extract All Variables' node", () => {
        const json = {
            conversationFlow: {
                nodes: [
                    {
                        name: "Confirm Name",
                        type: "extract_dynamic_variables",
                        variables: [
                            { name: "full_name", type: "string" },
                            { name: "phone_number", type: "string" },
                        ],
                    },
                    {
                        name: "Confirm City",
                        type: "extract_dynamic_variables",
                        variables: [
                            { name: "phone_number", type: "string" }, // duplicate
                            { name: "city", type: "string" },
                        ],
                    },
                ],
            },
        };
        const vars = extractVariables(json);
        expect(vars).toHaveLength(3);
        expect(vars.map((v) => v.key)).toEqual([
            "full_name",
            "phone_number",
            "city",
        ]);
    });
    it("deduplicates variables in fallback mode", () => {
        const json = {
            conversationFlow: {
                nodes: [
                    {
                        name: "Extract A",
                        type: "extract_dynamic_variables",
                        variables: [{ name: "full_name", type: "string" }],
                    },
                    {
                        name: "Extract B",
                        type: "extract_dynamic_variables",
                        variables: [{ name: "full_name", type: "string" }],
                    },
                ],
            },
        };
        const vars = extractVariables(json);
        expect(vars).toHaveLength(1);
    });
    it("returns empty array when no conversationFlow", () => {
        expect(extractVariables({})).toEqual([]);
    });
    it("returns empty array when no nodes", () => {
        expect(extractVariables({ conversationFlow: {} })).toEqual([]);
    });
    it("returns empty array when nodes is not an array", () => {
        expect(extractVariables({ conversationFlow: { nodes: "not-array" } })).toEqual([]);
    });
    it("returns empty array when Extract All Variables has no variables array", () => {
        const json = {
            conversationFlow: {
                nodes: [
                    {
                        name: "Extract All Variables",
                        type: "extract_dynamic_variables",
                        // no variables property
                    },
                ],
            },
        };
        expect(extractVariables(json)).toEqual([]);
    });
    it("skips non-extract nodes in fallback", () => {
        const json = {
            conversationFlow: {
                nodes: [
                    {
                        name: "Intro",
                        type: "conversation",
                        variables: [{ name: "should_not_appear", type: "string" }],
                    },
                    {
                        name: "Confirm Name",
                        type: "extract_dynamic_variables",
                        variables: [{ name: "full_name", type: "string" }],
                    },
                ],
            },
        };
        const vars = extractVariables(json);
        expect(vars).toHaveLength(1);
        expect(vars[0].key).toBe("full_name");
    });
    it("applies LABEL_MAP to extracted variable names", () => {
        const json = {
            conversationFlow: {
                nodes: [
                    {
                        name: "Extract All Variables",
                        type: "extract_dynamic_variables",
                        variables: [
                            { name: "full_name", type: "string" },
                            { name: "truck_number", type: "string" },
                        ],
                    },
                ],
            },
        };
        const vars = extractVariables(json);
        expect(vars[0]).toEqual({ key: "full_name", label: "Name" });
        expect(vars[1]).toEqual({ key: "truck_number", label: "Truck #" });
    });
});
// ── pushFlowToRetell ─────────────────────────────────────────────────────────
describe("pushFlowToRetell", () => {
    it("calls conversationFlow.update with stripped params", async () => {
        const mockUpdate = vi.fn().mockResolvedValue({});
        const retell = { conversationFlow: { update: mockUpdate } };
        await pushFlowToRetell(retell, "cf_123", {
            conversationFlow: {
                conversation_flow_id: "cf_123", // should be stripped
                version: 5, // stripped
                is_published: true, // stripped
                global_prompt: "Hi",
                nodes: [{ id: "n1" }],
            },
        });
        expect(mockUpdate).toHaveBeenCalledTimes(1);
        expect(mockUpdate).toHaveBeenCalledWith("cf_123", expect.objectContaining({
            global_prompt: "Hi",
            nodes: [{ id: "n1" }],
        }));
        const args = mockUpdate.mock.calls[0][1];
        expect(args).not.toHaveProperty("conversation_flow_id");
        expect(args).not.toHaveProperty("version");
        expect(args).not.toHaveProperty("is_published");
    });
    it("throws when conversationFlow is missing from canonical JSON", async () => {
        const retell = { conversationFlow: { update: vi.fn() } };
        await expect(pushFlowToRetell(retell, "cf_x", {})).rejects.toThrow("Missing conversationFlow");
    });
    it("propagates errors from the SDK", async () => {
        const mockUpdate = vi.fn().mockRejectedValue(new Error("rate limited"));
        const retell = { conversationFlow: { update: mockUpdate } };
        await expect(pushFlowToRetell(retell, "cf_x", { conversationFlow: { nodes: [] } })).rejects.toThrow("rate limited");
    });
});
// ── fetchRetellAgent ─────────────────────────────────────────────────────────
describe("fetchRetellAgent", () => {
    function makeRetell(overrides = {}) {
        return {
            agent: {
                retrieve: overrides.agentError
                    ? vi.fn().mockRejectedValue(overrides.agentError)
                    : vi.fn().mockResolvedValue(overrides.agent ?? {
                        agent_id: "agent_x",
                        agent_name: "Test",
                        response_engine: {
                            type: "conversation-flow",
                            conversation_flow_id: "cf_1",
                            version: 2,
                        },
                    }),
            },
            conversationFlow: {
                retrieve: overrides.flowError
                    ? vi.fn().mockRejectedValue(overrides.flowError)
                    : vi.fn().mockResolvedValue(overrides.flow ?? {
                        conversation_flow_id: "cf_1",
                        global_prompt: "Hi",
                        nodes: [
                            {
                                name: "Extract All Variables",
                                type: "extract_dynamic_variables",
                                variables: [{ name: "full_name", type: "string" }],
                            },
                        ],
                    }),
            },
        };
    }
    it("returns a snapshot with merged canonical JSON", async () => {
        const retell = makeRetell();
        const snap = await fetchRetellAgent(retell, "agent_x");
        expect(snap.agentId).toBe("agent_x");
        expect(snap.agentName).toBe("Test");
        expect(snap.conversationFlowId).toBe("cf_1");
        expect(snap.canonicalJson.conversationFlow).toEqual(expect.objectContaining({ global_prompt: "Hi" }));
        expect(snap.canonicalJson.response_engine).toEqual({
            type: "conversation-flow",
            version: 1,
        });
        // agent_id preserved on top-level
        expect(snap.canonicalJson.agent_id).toBe("agent_x");
    });
    it("extracts variables from the merged canonical JSON", async () => {
        const retell = makeRetell();
        const snap = await fetchRetellAgent(retell, "agent_x");
        expect(snap.variables).toEqual([{ key: "full_name", label: "Name" }]);
    });
    it("throws when agent response_engine is not conversation-flow type", async () => {
        const retell = makeRetell({
            agent: {
                agent_id: "agent_x",
                response_engine: { type: "retell-llm", llm_id: "llm_1" },
            },
        });
        await expect(fetchRetellAgent(retell, "agent_x")).rejects.toThrow("does not use a conversation-flow response engine");
    });
    it("throws when response_engine is missing entirely", async () => {
        const retell = makeRetell({
            agent: { agent_id: "agent_x" },
        });
        await expect(fetchRetellAgent(retell, "agent_x")).rejects.toThrow("does not use a conversation-flow response engine");
    });
    it("throws when conversation_flow_id is missing", async () => {
        const retell = makeRetell({
            agent: {
                agent_id: "agent_x",
                response_engine: { type: "conversation-flow" }, // no flow id
            },
        });
        await expect(fetchRetellAgent(retell, "agent_x")).rejects.toThrow("no conversation_flow_id");
    });
    it("propagates agent.retrieve errors", async () => {
        const retell = makeRetell({ agentError: new Error("not found") });
        await expect(fetchRetellAgent(retell, "agent_x")).rejects.toThrow("not found");
    });
    it("propagates conversationFlow.retrieve errors", async () => {
        const retell = makeRetell({ flowError: new Error("flow gone") });
        await expect(fetchRetellAgent(retell, "agent_x")).rejects.toThrow("flow gone");
    });
    it("defaults agentName to empty string when missing", async () => {
        const retell = makeRetell({
            agent: {
                agent_id: "agent_x",
                response_engine: { type: "conversation-flow", conversation_flow_id: "cf_1" },
            },
        });
        const snap = await fetchRetellAgent(retell, "agent_x");
        expect(snap.agentName).toBe("");
    });
});
