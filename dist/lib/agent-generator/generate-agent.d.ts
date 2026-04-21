import { type DataPoint, type RawDataPoint } from "./data-point-registry.js";
import { type AgentConfig } from "./node-builders.js";
export declare function resolveDataPoints(rawDataPoints: RawDataPoint[]): DataPoint[];
export declare function generateAgent(agentConfig: AgentConfig, rawDataPoints: RawDataPoint[]): {
    agent: Record<string, unknown>;
    resolved: DataPoint[];
};
