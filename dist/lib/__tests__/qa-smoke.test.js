import { describe, it, expect } from "vitest";
import { checkGreetingBusinessName, checkDataPointsInFlow, checkNotificationConfigComplete, checkMessageTypeResolves, checkRequiredFieldsSatisfiable, buildSyntheticVariables, } from "../qa-smoke.js";
// ── Fixtures ─────────────────────────────────────────────────────────────────
function makeSnapshot(overrides = {}) {
    return {
        agentId: "agent_test",
        agentName: "Test Agent",
        conversationFlowId: "cf_test",
        variables: [
            { key: "full_name", label: "Full Name" },
            { key: "phone_number", label: "Phone Number" },
            { key: "problem_description", label: "Problem Description" },
        ],
        canonicalJson: {
            conversationFlow: {
                start_node_id: "node-intro",
                global_prompt: "You are Anthony, an inbound receptionist for Test Plumbing.",
                nodes: [
                    {
                        id: "node-intro",
                        type: "conversation",
                        name: "Intro",
                        instruction: {
                            type: "prompt",
                            text: 'Welcome the caller: "Thank you for calling Test Plumbing, this is Anthony."',
                        },
                    },
                ],
            },
        },
        ...overrides,
    };
}
function makeClientDoc(overrides = {}) {
    return {
        _id: "test-plumbing",
        name: "Test Plumbing",
        agent_ids: ["agent_test"],
        dispatch_text_numbers: ["+15551234567"],
        dispatch_call_number: null,
        summary_agent_id: null,
        outbound_from_number: null,
        dispatch_email: ["dispatch@test.com"],
        dispatch_cc: null,
        message_types: {
            service_request: {
                label: "New Service Request",
                subject_template: "Service Request: {{full_name}}",
                fields: [
                    { key: "full_name", label: "Name" },
                    { key: "phone_number", label: "Phone" },
                    { key: "problem_description", label: "Problem" },
                ],
            },
        },
        default_message_type: "service_request",
        ...overrides,
    };
}
// ── greeting_has_business_name ───────────────────────────────────────────────
describe("checkGreetingBusinessName", () => {
    it("passes when name is in both global prompt and intro node", () => {
        const result = checkGreetingBusinessName(makeSnapshot(), makeClientDoc());
        expect(result.status).toBe("pass");
        expect(result.message).toContain("global prompt and intro node");
    });
    it("passes when name is only in global prompt", () => {
        const snapshot = makeSnapshot({
            canonicalJson: {
                conversationFlow: {
                    start_node_id: "node-intro",
                    global_prompt: "You are Anthony, an inbound receptionist for Test Plumbing.",
                    nodes: [
                        {
                            id: "node-intro",
                            type: "conversation",
                            instruction: { type: "prompt", text: "Welcome the caller." },
                        },
                    ],
                },
            },
        });
        const result = checkGreetingBusinessName(snapshot, makeClientDoc());
        expect(result.status).toBe("pass");
        expect(result.message).toContain("global prompt");
    });
    it("passes when name is only in intro node", () => {
        const snapshot = makeSnapshot({
            canonicalJson: {
                conversationFlow: {
                    start_node_id: "node-intro",
                    global_prompt: "You are a receptionist.",
                    nodes: [
                        {
                            id: "node-intro",
                            type: "conversation",
                            instruction: { type: "prompt", text: "Thank you for calling Test Plumbing." },
                        },
                    ],
                },
            },
        });
        const result = checkGreetingBusinessName(snapshot, makeClientDoc());
        expect(result.status).toBe("pass");
        expect(result.message).toContain("intro node");
    });
    it("fails when name is missing from both", () => {
        const snapshot = makeSnapshot({
            canonicalJson: {
                conversationFlow: {
                    start_node_id: "node-intro",
                    global_prompt: "You are a receptionist.",
                    nodes: [
                        {
                            id: "node-intro",
                            type: "conversation",
                            instruction: { type: "prompt", text: "Welcome, how can I help?" },
                        },
                    ],
                },
            },
        });
        const result = checkGreetingBusinessName(snapshot, makeClientDoc());
        expect(result.status).toBe("fail");
        expect(result.message).toContain("not found");
    });
    it("matches case-insensitively", () => {
        const snapshot = makeSnapshot({
            canonicalJson: {
                conversationFlow: {
                    start_node_id: "node-intro",
                    global_prompt: "You are Anthony for TEST PLUMBING.",
                    nodes: [
                        {
                            id: "node-intro",
                            type: "conversation",
                            instruction: { type: "prompt", text: "Welcome." },
                        },
                    ],
                },
            },
        });
        const result = checkGreetingBusinessName(snapshot, makeClientDoc());
        expect(result.status).toBe("pass");
    });
    it("handles string instruction format", () => {
        const snapshot = makeSnapshot({
            canonicalJson: {
                conversationFlow: {
                    start_node_id: "node-intro",
                    global_prompt: "Receptionist.",
                    nodes: [
                        {
                            id: "node-intro",
                            type: "conversation",
                            instruction: "Thank you for calling Test Plumbing.",
                        },
                    ],
                },
            },
        });
        const result = checkGreetingBusinessName(snapshot, makeClientDoc());
        expect(result.status).toBe("pass");
    });
    it("fails when no conversation flow", () => {
        const snapshot = makeSnapshot({ canonicalJson: {} });
        const result = checkGreetingBusinessName(snapshot, makeClientDoc());
        expect(result.status).toBe("fail");
        expect(result.message).toContain("No conversation flow");
    });
});
// ── data_points_in_flow ──────────────────────────────────────────────────────
describe("checkDataPointsInFlow", () => {
    it("passes when all fields are present in flow variables", () => {
        const result = checkDataPointsInFlow(makeSnapshot(), makeClientDoc());
        expect(result.status).toBe("pass");
        expect(result.message).toContain("3 notification fields");
    });
    it("fails when a field is missing from flow variables", () => {
        const snapshot = makeSnapshot({
            variables: [
                { key: "full_name", label: "Full Name" },
                { key: "phone_number", label: "Phone" },
                // missing problem_description
            ],
        });
        const result = checkDataPointsInFlow(snapshot, makeClientDoc());
        expect(result.status).toBe("fail");
        expect(result.message).toContain("problem_description");
    });
    it("passes with empty message type fields", () => {
        const client = makeClientDoc({
            message_types: {
                service_request: {
                    label: "SR",
                    subject_template: "SR",
                    fields: [],
                },
            },
        });
        const result = checkDataPointsInFlow(makeSnapshot(), client);
        expect(result.status).toBe("pass");
        expect(result.message).toContain("0 notification fields");
    });
});
// ── notification_config_complete ─────────────────────────────────────────────
describe("checkNotificationConfigComplete", () => {
    it("passes with SMS and email configured", () => {
        const result = checkNotificationConfigComplete(makeClientDoc());
        expect(result.status).toBe("pass");
        expect(result.message).toContain("1 SMS");
        expect(result.message).toContain("1 email");
    });
    it("passes with SMS only", () => {
        const result = checkNotificationConfigComplete(makeClientDoc({ dispatch_email: null }));
        expect(result.status).toBe("pass");
    });
    it("fails with no dispatch channels", () => {
        const result = checkNotificationConfigComplete(makeClientDoc({ dispatch_text_numbers: [], dispatch_email: null }));
        expect(result.status).toBe("fail");
        expect(result.message).toContain("no dispatch channels");
    });
    it("fails with no message types", () => {
        const result = checkNotificationConfigComplete(makeClientDoc({ message_types: {} }));
        expect(result.status).toBe("fail");
        expect(result.message).toContain("no message_types");
    });
    it("fails when default_message_type is missing from message_types", () => {
        const result = checkNotificationConfigComplete(makeClientDoc({ default_message_type: "nonexistent" }));
        expect(result.status).toBe("fail");
        expect(result.message).toContain("nonexistent");
    });
});
// ── message_type_resolves ────────────────────────────────────────────────────
describe("checkMessageTypeResolves", () => {
    it("passes with no rules (defaults)", () => {
        const result = checkMessageTypeResolves(makeClientDoc());
        expect(result.status).toBe("pass");
        expect(result.message).toContain("service_request");
    });
    it("passes with a binary resolve_rule", () => {
        const client = makeClientDoc({
            resolve_rule: { field: "is_emergency", equals: "true", then: "emergency", else: "service_request" },
            message_types: {
                emergency: { label: "Emergency", subject_template: "E", fields: [{ key: "full_name", label: "Name" }] },
                service_request: { label: "SR", subject_template: "SR", fields: [{ key: "full_name", label: "Name" }] },
            },
        });
        const result = checkMessageTypeResolves(client);
        expect(result.status).toBe("pass");
    });
    it("passes with multi-path resolve_rules", () => {
        const client = makeClientDoc({
            resolve_rules: [
                { field: "vehicle_type", equals: "Semi", then: "heavy" },
                { field: "vehicle_type", equals: "Pickup", then: "light" },
            ],
            message_types: {
                heavy: { label: "Heavy", subject_template: "H", fields: [{ key: "full_name", label: "Name" }] },
                light: { label: "Light", subject_template: "L", fields: [{ key: "full_name", label: "Name" }] },
                service_request: { label: "SR", subject_template: "SR", fields: [{ key: "full_name", label: "Name" }] },
            },
        });
        const result = checkMessageTypeResolves(client);
        expect(result.status).toBe("pass");
    });
    it("fails when resolution points to invalid key", () => {
        const client = makeClientDoc({
            resolve_rule: { field: "is_emergency", equals: "true", then: "nonexistent", else: "service_request" },
        });
        // With synthetic vars, is_emergency = "false", so resolves to "service_request" (valid)
        // But empty vars resolves to "service_request" too (the else). Let's force it:
        const client2 = makeClientDoc({
            resolve_rule: { field: "x", equals: "y", then: "service_request", else: "missing_type" },
        });
        const result = checkMessageTypeResolves(client2);
        expect(result.status).toBe("warn");
        expect(result.message).toContain("missing_type");
    });
});
// ── required_fields_satisfiable ──────────────────────────────────────────────
describe("checkRequiredFieldsSatisfiable", () => {
    it("passes when all required fields are in flow variables", () => {
        const client = makeClientDoc({
            message_types: {
                service_request: {
                    label: "SR",
                    subject_template: "SR",
                    fields: [
                        { key: "full_name", label: "Name", required: true },
                        { key: "phone_number", label: "Phone" },
                    ],
                },
            },
        });
        const result = checkRequiredFieldsSatisfiable(makeSnapshot(), client);
        expect(result.status).toBe("pass");
        expect(result.message).toContain("1 required field");
    });
    it("fails when required field is not in flow variables", () => {
        const client = makeClientDoc({
            message_types: {
                service_request: {
                    label: "SR",
                    subject_template: "SR",
                    fields: [
                        { key: "missing_field", label: "Missing", required: true },
                    ],
                },
            },
        });
        const result = checkRequiredFieldsSatisfiable(makeSnapshot(), client);
        expect(result.status).toBe("fail");
        expect(result.message).toContain("missing_field");
    });
    it("passes when no fields are required", () => {
        const result = checkRequiredFieldsSatisfiable(makeSnapshot(), makeClientDoc());
        expect(result.status).toBe("pass");
        expect(result.message).toContain("0 required field");
    });
});
// ── buildSyntheticVariables ──────────────────────────────────────────────────
describe("buildSyntheticVariables", () => {
    it("returns known values for standard field keys", () => {
        const vars = buildSyntheticVariables(makeClientDoc());
        expect(vars.full_name).toBe("QA Smoke Test");
        expect(vars.phone_number).toBe("555-000-0000");
        expect(vars.problem_description).toContain("smoke test");
    });
    it("returns fallback for unknown field keys", () => {
        const client = makeClientDoc({
            message_types: {
                service_request: {
                    label: "SR",
                    subject_template: "SR",
                    fields: [{ key: "custom_widget", label: "Widget" }],
                },
            },
        });
        const vars = buildSyntheticVariables(client);
        expect(vars.custom_widget).toBe("test_value");
    });
    it("sets resolve_rule field for binary rule", () => {
        const client = makeClientDoc({
            resolve_rule: { field: "is_emergency", equals: "true", then: "emergency", else: "service_request" },
        });
        const vars = buildSyntheticVariables(client);
        expect(vars.is_emergency).toBe("false");
    });
    it("sets resolve_rules field for multi-path rules", () => {
        const client = makeClientDoc({
            resolve_rules: [
                { field: "vehicle_type", equals: "Semi", then: "heavy" },
            ],
        });
        const vars = buildSyntheticVariables(client);
        expect(vars.vehicle_type).toBe("Semi");
    });
});
