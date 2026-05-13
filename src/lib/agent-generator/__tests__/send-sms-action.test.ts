import { describe, it, expect } from "vitest";
import { generateAgent, NOT_MENTIONED, defaultExtractEquation } from "../index.js";
import type { DataPoint } from "../data-point-registry.js";
import { SEND_SMS_TOOL_ID, SEND_SMS_TOOL_URL } from "../node-builders.js";

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
  it("registers the send_sms tool when a path uses it", () => {
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
    expect(flow.tools).toHaveLength(1);
    expect(flow.tools[0].name).toBe(SEND_SMS_TOOL_ID);
    expect(flow.tools[0].tool_id).toBe(SEND_SMS_TOOL_ID);
    expect(flow.tools[0].url).toBe(SEND_SMS_TOOL_URL);
    expect(flow.tools[0].type).toBe("custom");
    expect(flow.tools[0].parameters.required).toEqual(["message"]);
    expect(flow.tools[0].headers.Authorization).toMatch(/^Bearer /);
  });

  it("emits an empty tools[] when no path uses sendSms", () => {
    const { agent } = generateAgent(
      baseConfig,
      ["phone_number", "address"],
      undefined,
      TEST_DEFAULTS,
    );
    const flow = agent.conversationFlow as any;
    expect(flow.tools).toEqual([]);
  });

  it("emits function + Mark Sent nodes for each SMS action", () => {
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

    // Function node — invokes send_sms, waits for result.
    const funcNode = nodes.find(
      (n) => n.type === "function" && n.tool_id === SEND_SMS_TOOL_ID,
    );
    expect(funcNode).toBeDefined();
    expect(funcNode.tool_type).toBe("local");
    expect(funcNode.wait_for_result).toBe(true);
    expect(funcNode.name).toContain("Send link");
    expect(funcNode.instruction.type).toBe("static_text");
    // The literal SMS body lands in the tool-args instruction; Retell does
    // {{var}} substitution before the request is fired.
    expect(funcNode.instruction.text).toContain("Booking link: https://book.example.com");

    // Mark Sent node — extract_dynamic_variables that flips the sentinel.
    const markSentNode = nodes.find((n) => n.name?.startsWith?.("Mark Send link Sent"));
    expect(markSentNode).toBeDefined();
    expect(markSentNode.type).toBe("extract_dynamic_variables");
    expect(markSentNode.variables).toHaveLength(1);
    expect(markSentNode.variables[0].type).toBe("boolean");
    expect(markSentNode.variables[0].description).toBe("Always set to true.");
    expect(markSentNode.variables[0].name).toMatch(/^is_sms_sent_\d+$/);

    // Function node's success edge goes to Mark Sent.
    expect(funcNode.edges).toHaveLength(1);
    expect(funcNode.edges[0].destination_node_id).toBe(markSentNode.id);
    // Failure edge ALSO goes to Mark Sent so the sentinel still flips after
    // a Twilio error (no retry loop; the failure is logged in outbound_messages).
    expect(funcNode.else_edge.destination_node_id).toBe(markSentNode.id);

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
    const funcNode = nodes.find(
      (n: any) => n.type === "function" && n.tool_id === SEND_SMS_TOOL_ID,
    );

    // Router has three edges (phone DP, SMS action, address DP) in source order.
    expect(router.edges).toHaveLength(3);
    expect(router.edges[0].destination_node_id).toBe(phoneCollect.id);
    expect(router.edges[1].destination_node_id).toBe(funcNode.id);
    expect(router.edges[2].destination_node_id).toBe(addressCollect.id);

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
