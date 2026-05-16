import { describe, it, expect } from "vitest";
import { generateAgent, NOT_MENTIONED, defaultExtractEquation } from "../index.js";
import type { DataPoint } from "../data-point-registry.js";
import { MCP_SERVER_NAME, MCP_SERVER_URL, SEND_SMS_TOOL_NAME } from "../node-builders.js";
import { parseConversationFlow } from "../../node-parser.js";
import { regenerateDataChain, applyRegeneratedChain } from "../../node-regenerator.js";

// Minimal fixtures mirroring the wider agent-generator.test.ts but trimmed to
// what these tests exercise.
const TEST_DEFAULTS: Record<string, DataPoint> = {
  phone_number: {
    label: "Phone Number",
    variableName: "phone_number",
    type: "string",
    description: `Phone number. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for their phone number.",
    forwardCondition: "Caller provided phone or said they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("phone_number"),
  },
  address: {
    label: "Address",
    variableName: "address",
    type: "string",
    description: `Address. If not mentioned, set to "${NOT_MENTIONED}".`,
    conversationPrompt: "Ask for their address.",
    forwardCondition: "Caller provided address or said they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("address"),
  },
};

const baseConfig = {
  businessName: "Test Co",
  faqKnowledgeBase: "FAQ",
  introFinetuneExamples: [],
};

describe("SMS action in path", () => {
  it("registers the servicecall-mcp server entry when a path uses SMS", () => {
    const paths = [
      {
        name: "Default",
        transitionCondition: "Always",
        dataPoints: [
          "phone_number",
          {
            _action: "sendSms" as const,
            template: "Hi {{phone_number}}, here's your link.",
          },
          "address",
        ],
      },
    ];
    const { agent } = generateAgent(baseConfig, [], paths, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    expect(flow.mcps).toHaveLength(1);
    expect(flow.mcps[0].name).toBe(MCP_SERVER_NAME);
    expect(flow.mcps[0].url).toBe(MCP_SERVER_URL);
    expect(flow.mcps[0].headers.Authorization).toMatch(/^Bearer /);
    // Retell rejects flow creation ("MCP id cannot be empty or null") if the
    // entry carries no id — it's required, and is what McpNodes bind to.
    expect(flow.mcps[0].id).toBe(MCP_SERVER_NAME);
    // CustomTool registration path is gone — flow.tools[] stays empty.
    expect(flow.tools).toEqual([]);
  });

  it("every McpNode's mcp_id binds to an mcps[] entry id", () => {
    // Retell pairs each McpNode to its server by mcp_id → mcps[].id, and
    // rejects the whole flow with "MCP id cannot be empty or null" when an
    // entry has no id. Guard the binding end to end so a regenerated or
    // generated flow can't ship an unbindable McpNode again.
    const paths = [
      {
        name: "Default",
        transitionCondition: "Always",
        dataPoints: [
          "phone_number",
          { _action: "sendSms" as const, template: "Hi", name: "Send link" },
          "address",
        ],
      },
    ];
    const { agent } = generateAgent(baseConfig, [], paths, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const mcps: any[] = flow.mcps;
    const nodes: any[] = flow.nodes;

    expect(mcps.length).toBeGreaterThan(0);
    for (const entry of mcps) {
      expect(typeof entry.id, "mcps[] entry id must be a string").toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
    }
    const entryIds = new Set(mcps.map((m) => m.id));
    const mcpNodes = nodes.filter((n) => n.type === "mcp");
    expect(mcpNodes.length).toBeGreaterThan(0);
    for (const node of mcpNodes) {
      expect(
        entryIds.has(node.mcp_id),
        `McpNode "${node.name}" mcp_id="${node.mcp_id}" has no matching mcps[] entry id`,
      ).toBe(true);
    }
  });

  it("emits empty mcps[] when no path uses sendSms", () => {
    const { agent } = generateAgent(
      baseConfig,
      ["phone_number", "address"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    expect(flow.mcps).toEqual([]);
    expect(flow.tools).toEqual([]);
  });

  it("emits McpNode + Mark Sent nodes for each SMS action", () => {
    const paths = [
      {
        name: "Default",
        transitionCondition: "Always",
        dataPoints: [
          "phone_number",
          {
            _action: "sendSms" as const,
            template: "Booking link: https://book.example.com",
            name: "Send link",
          },
          "address",
        ],
      },
    ];
    const { agent } = generateAgent(baseConfig, [], paths, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const nodes: any[] = flow.nodes;

    // McpNode — invokes send_sms on the servicecall-mcp server.
    const mcpNode = nodes.find(
      (n) => n.type === "mcp" && n.mcp_tool_name === SEND_SMS_TOOL_NAME,
    );
    expect(mcpNode).toBeDefined();
    expect(mcpNode.mcp_id).toBe(MCP_SERVER_NAME);
    expect(mcpNode.wait_for_result).toBe(true);
    expect(mcpNode.name).toContain("Send link");
    expect(mcpNode.instruction.type).toBe("static_text");
    // The literal SMS body lands in the tool-args instruction; Retell does
    // {{var}} substitution before the request is fired.
    expect(mcpNode.instruction.text).toContain("Booking link: https://book.example.com");

    // Mark Sent node — extract_dynamic_variables that flips the sentinel.
    const markSentNode = nodes.find((n) => n.name?.startsWith?.("Mark Send link Sent"));
    expect(markSentNode).toBeDefined();
    expect(markSentNode.type).toBe("extract_dynamic_variables");
    expect(markSentNode.variables).toHaveLength(1);
    expect(markSentNode.variables[0].type).toBe("boolean");
    expect(markSentNode.variables[0].description).toBe("Always set to true.");
    expect(markSentNode.variables[0].name).toMatch(/^is_sms_sent_\d+$/);

    // McpNode's success edge goes to Mark Sent.
    expect(mcpNode.edges).toHaveLength(1);
    expect(mcpNode.edges[0].destination_node_id).toBe(markSentNode.id);
    // Failure edge also goes to Mark Sent. Retell requires the literal "Else"
    // on else_edge transition prompts — this was a deploy-blocking validation
    // when we used arbitrary strings.
    expect(mcpNode.else_edge.destination_node_id).toBe(markSentNode.id);
    expect(mcpNode.else_edge.transition_condition.prompt).toBe("Else");

    // Mark Sent loops back to the Variables Router.
    const router = nodes.find((n) => n.name === "Variables Router");
    expect(router).toBeDefined();
    expect(markSentNode.else_edge.destination_node_id).toBe(router.id);
  });

  it("places the SMS router edge between prior and following DP edges", () => {
    const paths = [
      {
        name: "Default",
        transitionCondition: "Always",
        dataPoints: [
          "phone_number",
          {
            _action: "sendSms" as const,
            template: "Hi",
          },
          "address",
        ],
      },
    ];
    const { agent } = generateAgent(baseConfig, [], paths, TEST_DEFAULTS);
    const flow = agent.conversationFlow as any;
    const nodes: any[] = flow.nodes;

    const router = nodes.find((n) => n.name === "Variables Router");
    const phoneCollect = nodes.find((n) => n.name === "Collect Phone Number");
    const addressCollect = nodes.find((n) => n.name === "Collect Address");
    const mcpNode = nodes.find(
      (n: any) => n.type === "mcp" && n.mcp_tool_name === SEND_SMS_TOOL_NAME,
    );

    // 3 source-order edges (phone DP, SMS action, address DP) + 1
    // _close_was_said shortcut at the end = 4 total.
    expect(router.edges).toHaveLength(4);
    expect(router.edges[0].destination_node_id).toBe(phoneCollect.id);
    expect(router.edges[1].destination_node_id).toBe(mcpNode.id);
    expect(router.edges[2].destination_node_id).toBe(addressCollect.id);
    // Last edge is the close-said shortcut, gated on the sentinel.
    expect(router.edges[3].transition_condition.equations[0].left).toBe("{{_close_was_said}}");

    // The SMS edge gates on the sentinel variable (not_exist || != "true")
    // so it fires exactly once after Mark Sent flips it to true.
    const smsEdge = router.edges[1];
    expect(smsEdge.transition_condition.type).toBe("equation");
    expect(smsEdge.transition_condition.operator).toBe("||");
    const eqs = smsEdge.transition_condition.equations;
    expect(eqs).toHaveLength(2);
    expect(eqs[0].operator).toBe("not_exist");
    expect(eqs[0].left).toMatch(/is_sms_sent_\d+/);
    expect(eqs[1].operator).toBe("!=");
    expect(eqs[1].right).toBe("true");
  });

  it("round-trips through parseConversationFlow with template + name preserved", () => {
    const paths = [
      {
        name: "Default",
        transitionCondition: "Always",
        dataPoints: [
          "phone_number",
          {
            _action: "sendSms" as const,
            template: "Hi {{first_name}}, your link: https://book.example.com/{{quote_id}}",
            name: "Booking link",
            to: "+15551234567",
          },
          "address",
        ],
      },
    ];
    const { agent } = generateAgent(baseConfig, [], paths, TEST_DEFAULTS);
    const parsed = parseConversationFlow(agent as any);
    expect(parsed.paths).toHaveLength(1);
    const path = parsed.paths[0];
    expect(path.smsActions).toHaveLength(1);
    const action = path.smsActions[0];
    expect(action.template).toBe(
      "Hi {{first_name}}, your link: https://book.example.com/{{quote_id}}",
    );
    expect(action.to).toBe("+15551234567");
    expect(action.displayName).toBe("Booking link");
    expect(action.sentinelVar).toMatch(/^is_sms_sent_\d+$/);

    // Steps interleave DPs and SMS actions in router-edge order.
    expect(path.steps).toHaveLength(3);
    expect(path.steps[0].kind).toBe("dp");
    expect(path.steps[1].kind).toBe("sms");
    expect(path.steps[2].kind).toBe("dp");
  });

  it("regenerator preserves SMS node IDs across save cycles", () => {
    const paths = [
      {
        name: "Default",
        transitionCondition: "Always",
        dataPoints: [
          "phone_number",
          { _action: "sendSms" as const, template: "Hello!", name: "Greet" },
          "address",
        ],
      },
    ];
    const { agent } = generateAgent(baseConfig, [], paths, TEST_DEFAULTS);
    const canonical = JSON.parse(JSON.stringify(agent));
    const parsed = parseConversationFlow(canonical);
    const originalPath = parsed.paths[0];
    const originalFuncId = originalPath.smsActions[0].funcNode.id;
    const originalMarkSentId = originalPath.smsActions[0].markSentNode.id;
    const originalSentinel = originalPath.smsActions[0].sentinelVar;

    // Pretend the operator tweaked the template; rebuild the data chain.
    const closeId = parsed.closeNode!.id;
    const closeQuestionId = parsed.closingNodes.find((n) => n.name === "Close Question")!.id;
    const newSequence = [
      { ...TEST_DEFAULTS.phone_number },
      { _action: "sendSms" as const, template: "Hello updated!", name: "Greet" },
      { ...TEST_DEFAULTS.address },
    ];
    const result = regenerateDataChain(originalPath, newSequence, closeId, closeQuestionId);
    applyRegeneratedChain(canonical, result);

    const reparsed = parseConversationFlow(canonical);
    const reparsedPath = reparsed.paths[0];
    expect(reparsedPath.smsActions).toHaveLength(1);
    expect(reparsedPath.smsActions[0].funcNode.id).toBe(originalFuncId);
    expect(reparsedPath.smsActions[0].markSentNode.id).toBe(originalMarkSentId);
    expect(reparsedPath.smsActions[0].sentinelVar).toBe(originalSentinel);
    expect(reparsedPath.smsActions[0].template).toBe("Hello updated!");
    // The regenerated node still has the McpNode shape.
    expect(reparsedPath.smsActions[0].funcNode.type).toBe("mcp");
    expect(reparsedPath.smsActions[0].funcNode.raw.mcp_id).toBe(MCP_SERVER_NAME);
  });

  it("rejects SMS actions inside branch chains with a clear error", () => {
    const paths = [
      {
        name: "Default",
        transitionCondition: "Always",
        dataPoints: [
          "phone_number",
          {
            _branch: true,
            variable: "phone_number",
            operator: "!=",
            value: NOT_MENTIONED,
            ifChain: [
              { _action: "sendSms" as const, template: "Hi" },
            ],
            elseChain: [],
          },
        ],
      },
    ];
    expect(() => generateAgent(baseConfig, [], paths as any, TEST_DEFAULTS)).toThrow(
      /SMS actions inside branch chains aren't supported/,
    );
  });
});
