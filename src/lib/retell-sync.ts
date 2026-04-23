import type Retell from "retell-sdk";
import { toLabel, type VariableEntry } from "./notification-config.js";
import { INTERNAL_VARS } from "./agent-generator/data-point-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetellAgentSnapshot {
  agentId: string;
  agentName: string;
  conversationFlowId: string;
  variables: VariableEntry[];
  canonicalJson: Record<string, unknown>;
}

// ── Strip keys for Retell SDK create calls ───────────────────────────────────

const AGENT_STRIP_KEYS = new Set([
  "agent_id",
  "channel",
  "last_modification_timestamp",
  "version",
  "is_published",
  "version_title",
  "conversationFlow",
  "response_engine",
]);

const FLOW_STRIP_KEYS = new Set([
  "conversation_flow_id",
  "version",
  "is_published",
  "flex_mode",
  "is_transfer_cf",
]);

export function extractFlowParams(conversationFlow: Record<string, unknown>) {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(conversationFlow)) {
    if (!FLOW_STRIP_KEYS.has(key)) {
      params[key] = value;
    }
  }
  return params;
}

export function extractAgentParams(
  agentJson: Record<string, unknown>,
  conversationFlowId: string,
) {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agentJson)) {
    if (!AGENT_STRIP_KEYS.has(key)) {
      params[key] = value;
    }
  }
  params.response_engine = {
    type: "conversation-flow" as const,
    conversation_flow_id: conversationFlowId,
  };
  return params;
}

// ── Variable Extraction ──────────────────────────────────────────────────────

interface NodeVariable {
  name: string;
  type?: string;
  description?: string;
}

export function extractVariables(
  canonicalJson: Record<string, unknown>,
): VariableEntry[] {
  const flow = canonicalJson.conversationFlow as
    | Record<string, unknown>
    | undefined;
  if (!flow) return [];

  const nodes = flow.nodes as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(nodes)) return [];

  // Try to find the "Extract All Variables" node first (has all vars)
  let extractNode = nodes.find(
    (n) =>
      n.type === "extract_dynamic_variables" &&
      n.name === "Extract All Variables",
  );

  // Fallback: collect from all extract_dynamic_variables nodes
  if (!extractNode) {
    const allVars: NodeVariable[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      if (node.type !== "extract_dynamic_variables") continue;
      const vars = node.variables as NodeVariable[] | undefined;
      if (!Array.isArray(vars)) continue;
      for (const v of vars) {
        if (!seen.has(v.name)) {
          seen.add(v.name);
          allVars.push(v);
        }
      }
    }
    return allVars
      .filter((v) => !INTERNAL_VARS.has(v.name))
      .map((v) => ({ key: v.name, label: toLabel(v.name) }));
  }

  const vars = extractNode.variables as NodeVariable[] | undefined;
  if (!Array.isArray(vars)) return [];

  return vars
    .filter((v) => !INTERNAL_VARS.has(v.name))
    .map((v) => ({ key: v.name, label: toLabel(v.name) }));
}

// ── Fetch from Retell API ────────────────────────────────────────────────────

export async function fetchRetellAgent(
  retell: Retell,
  agentId: string,
): Promise<RetellAgentSnapshot> {
  // 1. Fetch agent
  const agent = await retell.agent.retrieve(agentId);
  const agentObj = agent as unknown as Record<string, unknown>;

  // 2. Extract conversation flow ID
  const responseEngine = agentObj.response_engine as
    | Record<string, unknown>
    | undefined;
  if (!responseEngine || responseEngine.type !== "conversation-flow") {
    throw new Error(
      `Agent ${agentId} does not use a conversation-flow response engine`,
    );
  }
  const conversationFlowId = responseEngine.conversation_flow_id as string;
  if (!conversationFlowId) {
    throw new Error(`Agent ${agentId} has no conversation_flow_id`);
  }

  // 3. Fetch conversation flow
  const flow = await retell.conversationFlow.retrieve(conversationFlowId);
  const flowObj = flow as unknown as Record<string, unknown>;

  // 4. Reconstruct canonical JSON (same format as generator output)
  const canonicalJson: Record<string, unknown> = { ...agentObj };
  canonicalJson.conversationFlow = flowObj;
  // Remove the response_engine that references the flow by ID
  // (canonical format has it nested instead)
  delete canonicalJson.response_engine;
  canonicalJson.response_engine = {
    type: "conversation-flow",
    version: 1,
  };

  // 5. Extract variables
  const variables = extractVariables(canonicalJson);

  return {
    agentId,
    agentName: (agentObj.agent_name as string) ?? "",
    conversationFlowId,
    variables,
    canonicalJson,
  };
}
