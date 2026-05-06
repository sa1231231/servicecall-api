import { type DataPoint, type RawDataPoint, type FinetuneExample } from "./data-point-registry.js";
import { type AgentConfig } from "./node-builders.js";
export type PathEndMode = "callback" | "transfer";
export interface PathConfig {
    name: string;
    transitionCondition: string;
    dataPoints: RawDataPoint[];
    endMode?: PathEndMode;
    /** Resolved E.164 number to transfer to. Required when endMode === "transfer". */
    transferDestination?: string;
    /** Positive examples that should route the caller to this path. Merged
     *  into the intro node's finetune_transition_examples at generation time
     *  with destination_node_id set to this path's transition node. */
    transitionFinetuneExamples?: FinetuneExample[];
}
export interface ResolvedPath {
    name: string;
    resolved: DataPoint[];
    endMode: PathEndMode;
    transferDestination?: string;
}
export declare function resolveDataPoints(rawDataPoints: RawDataPoint[], defaults: Record<string, DataPoint>): DataPoint[];
export declare function generateAgent(agentConfig: AgentConfig, rawDataPoints: RawDataPoint[], pathConfigs: PathConfig[] | undefined, defaults: Record<string, DataPoint>): {
    agent: Record<string, unknown>;
    resolved: DataPoint[];
    resolvedPaths?: ResolvedPath[];
};
