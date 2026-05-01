export interface AlertResult {
    callSurge: {
        fired: boolean;
        count: number;
    };
    costSurge: {
        fired: boolean;
        totalCents: number;
    };
}
export declare function checkAgentAlerts(agentId: string, callCostCents?: number): AlertResult;
