import { CALLER_DOESNT_KNOW, NOT_MENTIONED } from "../../lib/agent-generator/data-point-registry.js";

export interface PathScenario {
  pathName: string;
  scenarioName: string;
  description: string;
  /** First user message — should bring the agent into the target path. */
  triggerMessage: string;
  /** Map variableName → user reply. The runner sends the reply when the agent enters that variable's Collect node. */
  replies: Record<string, string>;
  /** Sent when the agent is in intro/transition nodes (not yet asking a path data point). */
  fillerReply?: string;
  /** Optional explicit assertions; if omitted, the test asserts each replied variable was extracted to a value matching the reply. */
  expectVariables?: Record<string, RegExp | string>;
  expectMessageTypeKey?: string;
  /** Safety cap on dialog length. */
  maxTurns?: number;
}

export const DEMO_METER_AGENT_ID = "agent_27340aa43ebbc5f4822a35225a";
export const DEMO_METER_SLUG = "demo-meter";

export const DEMO_METER_SCENARIOS: PathScenario[] = [
  {
    pathName: "measure_me",
    scenarioName: "happy_residential_efs",
    description: "Clean replies — Residential + EFS payment exercises the EFS branch (state collected, warranty skipped)",
    triggerMessage: "Hi, I'd like to schedule a meter measurement.",
    replies: {
      email: "test+measure@example.com",
      full_name: "John Smith",
      property_type: "Residential",
      preferred_day: "Tuesday",
      preferred_time: "Afternoon",
      payment_method: "EFS",
      state: "Texas",
      truck_number: "Truck 42",
    },
    fillerReply: "Yes please, go ahead.",
    expectVariables: {
      email: /test\+measure@example\.com/i,
      full_name: /john\s*smith/i,
      property_type: /residential/i,
    },
    expectMessageTypeKey: "measure_me",
  },
  {
    pathName: "measure_me",
    scenarioName: "ambiguous_residential_check",
    description: "Hedgy/ambiguous replies — exercises whether descriptions steer the LLM correctly when callers waffle",
    triggerMessage: "I want to schedule something.",
    replies: {
      email: "ambiguous-test@example.com",
      full_name: "Sarah Johnson",
      property_type: "It's a house",
      preferred_day: "Maybe later this week",
      preferred_time: "Afternoon I guess",
      payment_method: "Check",
      warranty_status: "Still under warranty I think",
      state: "Florida",
      truck_number: "Truck 99",
    },
    fillerReply: "Sure, go on.",
    expectVariables: {
      email: /ambiguous-test@example\.com/i,
      full_name: /sarah\s*johnson/i,
      property_type: /residential/i,
    },
    expectMessageTypeKey: "measure_me",
  },
  {
    pathName: "dont_measure_me",
    scenarioName: "happy_decline",
    description: "Caller declines measurement, gives clear reason — exercises why_reason extraction",
    triggerMessage: "I don't actually need a measurement.",
    replies: {
      full_name: "Jane Doe",
      truck_number: "Truck 17",
      why_reason: "I already have one scheduled with another vendor.",
    },
    fillerReply: "Yes please.",
    expectVariables: {
      full_name: /jane\s*doe/i,
      truck_number: /17/,
      why_reason: /\S/,
    },
    expectMessageTypeKey: "service_request",
  },
  {
    pathName: "dont_measure_me",
    scenarioName: "terse_decline",
    description: "Caller declines with terse replies — tests whether prompts elicit the data points",
    triggerMessage: "Skip the measurement.",
    replies: {
      full_name: "Mike Brown",
      truck_number: "Five",
      why_reason: "Don't need it.",
    },
    fillerReply: "Go on.",
    expectVariables: {
      full_name: /mike\s*brown/i,
      truck_number: /5|five/i,
      why_reason: /\S/,
    },
    expectMessageTypeKey: "service_request",
  },
];
