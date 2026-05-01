import { type WithId } from "mongodb";
export interface AgentVersionDoc {
    slug: string;
    agentId: string;
    version: number;
    canonicalJson: Record<string, unknown>;
    source: "manual_edit" | "rollback" | "auto_sync" | "creation";
    description: string;
    createdBy: string;
    createdAt: Date;
    nodeCount: number;
    dataPointCount: number;
}
export declare function createVersionSnapshot(slug: string, agentId: string, canonicalJson: Record<string, unknown>, source: AgentVersionDoc["source"], description: string, createdBy: string): Promise<WithId<AgentVersionDoc>>;
export declare function listVersions(slug: string, agentId: string, opts?: {
    limit?: number;
    offset?: number;
}): Promise<{
    versions: WithId<AgentVersionDoc>[];
    total: number;
}>;
export declare function getVersion(versionId: string): Promise<WithId<AgentVersionDoc> | null>;
export declare function getLatestVersion(slug: string, agentId: string): Promise<WithId<AgentVersionDoc> | null>;
export declare function ensureVersionIndexes(): Promise<void>;
