/**
 * Parses a canonical JSON conversation flow back into a structured
 * representation, reversing the output of node-builders.ts.
 */
export interface ParsedNode {
    raw: Record<string, unknown>;
    id: string;
    name: string;
    type: string;
}
export interface ParsedDataPoint {
    variableName: string;
    label: string;
    collectNode: ParsedNode;
    confirmNode: ParsedNode;
    variableDefs: Array<{
        name: string;
        type: string;
        description: string;
        choices?: string[];
    }>;
    conversationPrompt: string;
    forwardCondition: string;
    orphan?: boolean;
}
export interface ParsedPath {
    name: string;
    transitionNode: ParsedNode;
    frontExtractNode: ParsedNode;
    routerNode: ParsedNode;
    dataChain: ParsedDataPoint[];
    endMode: "callback" | "transfer";
    preTransferNode?: ParsedNode;
    transferCallNode?: ParsedNode;
    /** Resolved E.164 number baked into the path's transfer_call node (when endMode === "transfer"). */
    transferDestination?: string;
}
export interface ParsedFlow {
    introNode: ParsedNode;
    faqNode: ParsedNode | null;
    closeNode: ParsedNode | null;
    closingNodes: ParsedNode[];
    globalNodes: ParsedNode[];
    paths: ParsedPath[];
    allNodes: ParsedNode[];
    startNodeId: string;
    globalPrompt: string;
}
export declare function parseConversationFlow(canonicalJson: Record<string, unknown>): ParsedFlow;
/** Get a set of all node IDs belonging to a specific path's data chain */
export declare function getPathNodeIds(path: ParsedPath): Set<string>;
/** Get a flat list of variable names in a path, in order */
export declare function getPathVariableNames(path: ParsedPath): string[];
/** Check if a node is a structural node (not part of any data chain) */
export declare function isStructuralNode(node: ParsedNode, parsedFlow: ParsedFlow): boolean;
