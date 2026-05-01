import type Retell from "retell-sdk";
import { type VariableEntry } from "./notification-config.js";
export interface RetellAgentSnapshot {
    agentId: string;
    agentName: string;
    conversationFlowId: string;
    variables: VariableEntry[];
    canonicalJson: Record<string, unknown>;
}
export declare function extractFlowParams(conversationFlow: Record<string, unknown>): Record<string, unknown>;
export declare function extractAgentParams(agentJson: Record<string, unknown>, conversationFlowId: string): Record<string, unknown>;
export declare function extractVariables(canonicalJson: Record<string, unknown>): VariableEntry[];
export declare function pushFlowToRetell(retell: Retell, flowId: string, canonicalJson: Record<string, unknown>): Promise<void>;
export declare function fetchRetellAgent(retell: Retell, agentId: string): Promise<RetellAgentSnapshot>;
