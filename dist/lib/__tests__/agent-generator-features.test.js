import { describe, it, expect } from "vitest";
import { generateAgent, NOT_MENTIONED, CALLER_DOESNT_KNOW, defaultExtractEquation, } from "../agent-generator/index.js";
// Minimal default registry — keep small; existing agent-generator.test.ts has the full TEST_DEFAULTS.
const DEFAULTS = {
    full_name: {
        label: "Full Name",
        variableName: "full_name",
        type: "string",
        description: `Full name. If not mentioned, set to "${NOT_MENTIONED}". If they don't know, set to "${CALLER_DOESNT_KNOW}".`,
        conversationPrompt: "Ask for the caller's name.",
        forwardCondition: "The caller has given their name",
        finetuneExamples: [],
        extractSuccessEquation: defaultExtractEquation("full_name"),
    },
};
const baseConfig = {
    businessName: "Test Co",
    faqKnowledgeBase: "Default FAQ",
    introFinetuneExamples: [],
};
function getFlow(agent) {
    return agent.conversationFlow ?? agent;
}
function findNodeByName(agent, name) {
    return getFlow(agent).nodes.find((n) => n.name === name);
}
describe("Agent creator — feature reflection", () => {
    describe("Custom prompt text lands in the right node", () => {
        it("faqKnowledgeBase populates the FAQ node instruction", () => {
            const { agent } = generateAgent({ ...baseConfig, faqKnowledgeBase: "MARKER_FAQ_TEXT_42" }, ["full_name"], undefined, DEFAULTS);
            const faq = findNodeByName(agent, "Admin/FAQ");
            expect(faq, "FAQ node missing").toBeDefined();
            expect(faq.instruction?.text ?? "").toContain("MARKER_FAQ_TEXT_42");
        });
        it("introFinetuneExamples are attached to the intro node", () => {
            const example = {
                type: "positive",
                transcript: [
                    { content: "MARKER_USER_INTRO", role: "user" },
                    { content: "MARKER_AGENT_INTRO", role: "agent" },
                ],
            };
            const { agent } = generateAgent({ ...baseConfig, introFinetuneExamples: [example] }, ["full_name"], undefined, DEFAULTS);
            const flow = getFlow(agent);
            const startNodeId = (agent.conversationFlow ?? agent).start_node_id;
            const intro = flow.nodes.find((n) => n.id === startNodeId);
            expect(intro, "intro/start node missing").toBeDefined();
            const examples = intro.finetune_transition_examples ?? intro.finetune_examples ?? [];
            const serialized = JSON.stringify(examples);
            expect(serialized).toContain("MARKER_USER_INTRO");
            expect(serialized).toContain("MARKER_AGENT_INTRO");
        });
        it("closePrompt populates the Close node (single-path)", () => {
            const { agent } = generateAgent({ ...baseConfig, closePrompt: "MARKER_CLOSE_PROMPT_99" }, ["full_name"], undefined, DEFAULTS);
            const close = findNodeByName(agent, "Close");
            expect(close, "Close node missing").toBeDefined();
            expect(close.instruction?.text ?? "").toContain("MARKER_CLOSE_PROMPT_99");
        });
        it("multi-path callback agents produce one Close node per path with the global closePrompt as default", () => {
            const { agent } = generateAgent({ ...baseConfig, closePrompt: "GLOBAL_DEFAULT_CLOSE" }, [], [
                { name: "Service", transitionCondition: "service request", dataPoints: ["full_name"] },
                { name: "Sales", transitionCondition: "sales inquiry", dataPoints: ["full_name"] },
            ], DEFAULTS);
            const flow = agent.conversationFlow;
            const closeService = flow.nodes.find((n) => n.name === "Close (Service)");
            const closeSales = flow.nodes.find((n) => n.name === "Close (Sales)");
            expect(closeService).toBeDefined();
            expect(closeSales).toBeDefined();
            expect(closeService.instruction.text).toContain("GLOBAL_DEFAULT_CLOSE");
            expect(closeSales.instruction.text).toContain("GLOBAL_DEFAULT_CLOSE");
            // No singleton "Close" node remains in multi-path
            expect(flow.nodes.find((n) => n.name === "Close")).toBeUndefined();
        });
        it("pathClosePrompts overrides the Close prompt per path; missing paths fall back to closePrompt", () => {
            const { agent } = generateAgent({
                ...baseConfig,
                closePrompt: "DEFAULT_CLOSE",
                pathClosePrompts: { Service: "SERVICE_CLOSE_OVERRIDE" },
            }, [], [
                { name: "Service", transitionCondition: "service request", dataPoints: ["full_name"] },
                { name: "Sales", transitionCondition: "sales inquiry", dataPoints: ["full_name"] },
            ], DEFAULTS);
            const flow = agent.conversationFlow;
            const closeService = flow.nodes.find((n) => n.name === "Close (Service)");
            const closeSales = flow.nodes.find((n) => n.name === "Close (Sales)");
            expect(closeService.instruction.text).toContain("SERVICE_CLOSE_OVERRIDE");
            expect(closeService.instruction.text).not.toContain("DEFAULT_CLOSE");
            expect(closeSales.instruction.text).toContain("DEFAULT_CLOSE");
        });
        it("transfer-mode paths in multi-path agents have no Close node", () => {
            const { agent } = generateAgent({ ...baseConfig, closePrompt: "X" }, [], [
                { name: "Emergency", transitionCondition: "emergency", dataPoints: ["full_name"], endMode: "transfer", transferDestination: "+18005551234" },
                { name: "General", transitionCondition: "general", dataPoints: ["full_name"] },
            ], DEFAULTS);
            const flow = agent.conversationFlow;
            expect(flow.nodes.find((n) => n.name === "Close (Emergency)")).toBeUndefined();
            expect(flow.nodes.find((n) => n.name === "Close (General)")).toBeDefined();
        });
        it("closingRemarksPrompt populates the Closing Remarks node", () => {
            const { agent } = generateAgent({ ...baseConfig, closingRemarksPrompt: "MARKER_REMARKS_77" }, ["full_name"], undefined, DEFAULTS);
            const remarks = findNodeByName(agent, "Closing Remarks");
            expect(remarks, "Closing Remarks node missing").toBeDefined();
            expect(remarks.instruction?.text ?? "").toContain("MARKER_REMARKS_77");
        });
        it("closingStatementText populates the Closing Statement node", () => {
            const { agent } = generateAgent({ ...baseConfig, closingStatementText: "MARKER_STATEMENT_55" }, ["full_name"], undefined, DEFAULTS);
            const statement = findNodeByName(agent, "Closing Statement");
            expect(statement, "Closing Statement node missing").toBeDefined();
            expect(statement.instruction?.text ?? "").toContain("MARKER_STATEMENT_55");
        });
        it("liveTransferRecoveryPrompt populates the Live Transfer Recovery node when humanRequestMode is live_transfer", () => {
            const { agent } = generateAgent({
                ...baseConfig,
                humanRequestMode: "live_transfer",
                liveTransferRecoveryPrompt: "MARKER_RECOVERY_33",
            }, ["full_name"], undefined, DEFAULTS);
            const recovery = findNodeByName(agent, "Live Transfer Recovery");
            expect(recovery, "Live Transfer Recovery node missing").toBeDefined();
            expect(recovery.instruction?.text ?? "").toContain("MARKER_RECOVERY_33");
        });
    });
    describe("humanRequestMode controls global transfer infrastructure", () => {
        it("callback mode does NOT generate a global Transfer Call node", () => {
            const { agent } = generateAgent({ ...baseConfig, humanRequestMode: "callback" }, ["full_name"], undefined, DEFAULTS);
            // The path-specific "Transfer Call (X)" can still exist for transfer paths,
            // but the global "Transfer Call" (no suffix) shouldn't appear in callback-only mode.
            const globalTransfer = findNodeByName(agent, "Transfer Call");
            expect(globalTransfer).toBeUndefined();
            const recovery = findNodeByName(agent, "Live Transfer Recovery");
            expect(recovery).toBeUndefined();
        });
        it("live_transfer mode generates Transfer Call AND Live Transfer Recovery nodes", () => {
            const { agent } = generateAgent({ ...baseConfig, humanRequestMode: "live_transfer" }, ["full_name"], undefined, DEFAULTS);
            expect(findNodeByName(agent, "Transfer Call")).toBeDefined();
            expect(findNodeByName(agent, "Live Transfer Recovery")).toBeDefined();
        });
    });
});
