import { type DataPoint, type RawDataPoint } from "./data-point-registry.js";
import { type AgentConfig } from "./node-builders.js";
export type PathEndMode = "callback" | "transfer";
export interface PathConfig {
    name: string;
    transitionCondition: string;
    dataPoints: RawDataPoint[];
    endMode?: PathEndMode;
    /** Resolved E.164 number to transfer to. Required when endMode === "transfer". */
    transferDestination?: string;
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
