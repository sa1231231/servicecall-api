import { type AgentConfig, type RawDataPoint } from "./agent-generator/index.js";
import type { HumanRequestMode } from "./agent-generator/node-builders.js";
export interface CreateAgentBody {
    business: AgentConfig & {
        human_request_mode?: HumanRequestMode;
    };
    dataPoints?: RawDataPoint[];
    paths?: Array<{
        name: string;
        transitionCondition: string;
        dataPoints: RawDataPoint[];
        end_mode?: "callback" | "transfer";
    }>;
    client: {
        slug: string;
        name?: string;
        dispatch_text_numbers: string[];
        dispatch_call_number?: string | null;
        dispatch_call_overrides?: Record<string, string>;
        dispatch_email?: string[] | null;
        dispatch_cc?: string | null;
        dispatch_by_type?: Record<string, {
            dispatch_text_numbers?: string[];
            dispatch_email?: string[];
            dispatch_cc?: string | null;
            dispatch_call_number?: string | null;
        }>;
        path_end_modes?: Record<string, "callback" | "transfer">;
        outbound_from_number?: string | null;
        summary_agent_id?: string | null;
        webhook_url?: string;
        notification_greeting?: string;
        weekly_report_enabled?: boolean;
        phone_fallback_to_caller?: boolean;
        hide_not_mentioned?: boolean;
        shadow_mode?: boolean;
    };
}
export interface CreateAgentSuccess {
    ok: true;
    agentId: string;
    conversationFlowId: string;
    slug: string;
    notificationConfig: Record<string, unknown>;
    provisionedNumber: string | null;
    provisionError: string | null;
}
export interface CreateAgentFailure {
    ok: false;
    status: number;
    error: string;
    details?: string;
}
export type CreateAgentResult = CreateAgentSuccess | CreateAgentFailure;
export declare function createAgentFromConfig(body: CreateAgentBody): Promise<CreateAgentResult>;
