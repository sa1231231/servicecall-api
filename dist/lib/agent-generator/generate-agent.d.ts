import { type DataPoint, type RawDataPoint } from "./data-point-registry.js";
import { type AgentConfig } from "./node-builders.js";
export interface PathConfig {
    name: string;
    transitionCondition: string;
    dataPoints: RawDataPoint[];
}
export interface ResolvedPath {
    name: string;
    resolved: DataPoint[];
}
export declare function resolveDataPoints(rawDataPoints: RawDataPoint[], defaults: Record<string, DataPoint>): DataPoint[];
export declare function generateAgent(agentConfig: AgentConfig, rawDataPoints: RawDataPoint[], pathConfigs: PathConfig[] | undefined, defaults: Record<string, DataPoint>): {
    agent: Record<string, unknown>;
    resolved: DataPoint[];
    resolvedPaths?: ResolvedPath[];
};
