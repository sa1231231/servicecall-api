import type Retell from "retell-sdk";
export interface RetellDisplaySyncResult {
    agentNameUpdated: boolean;
    nicknameUpdated: string[];
    nicknameErrors: string[];
}
export declare function syncRetellDisplayLabels(retellClient: Retell, agentId: string, outboundFromNumber: string | null | undefined, label: string): Promise<RetellDisplaySyncResult>;
