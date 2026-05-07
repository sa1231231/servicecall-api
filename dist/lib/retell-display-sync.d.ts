import type Retell from "retell-sdk";
export interface RetellDisplaySyncResult {
    agentNameUpdated: boolean;
    nicknameUpdated: string[];
    nicknameErrors: string[];
    friendlyNameUpdated: string[];
    friendlyNameErrors: string[];
}
export declare function syncRetellDisplayLabels(retellClient: Retell, slug: string, agentId: string, outboundFromNumber: string | null | undefined, label: string): Promise<RetellDisplaySyncResult>;
