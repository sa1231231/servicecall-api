/**
 * Regenerates the data chain portion of a conversation flow for a specific path.
 * Uses the same patterns as node-builders.ts buildDataChain() but operates on
 * an existing parsed flow, preserving node IDs and custom prompts where possible.
 */
import type { DataPoint } from "./agent-generator/data-point-registry.js";
import type { ParsedPath } from "./node-parser.js";
interface RegenerateResult {
    /** Replacement nodes for the path (front-extract + router + data chain) */
    newNodes: Record<string, unknown>[];
    /** Node IDs that should be removed from the full nodes array */
    removedNodeIds: Set<string>;
}
/**
 * Regenerates the data chain for a given path with an updated set of data points.
 *
 * Preserves:
 * - Existing node IDs for unchanged data points (same variableName, same position)
 * - Custom prompt text on existing collect nodes (Retell console tweaks)
 * - The front-extract node ID and router node ID
 * - display_position values from existing nodes
 *
 * Generates new IDs only for genuinely new nodes.
 */
export declare function regenerateDataChain(existingPath: ParsedPath, newDataPoints: DataPoint[], closeNodeId: string, pathName?: string): RegenerateResult;
/**
 * Applies a regenerated data chain to a canonical JSON, replacing old nodes
 * with new ones while preserving all other nodes.
 */
export declare function applyRegeneratedChain(canonicalJson: Record<string, unknown>, result: RegenerateResult): void;
export {};
