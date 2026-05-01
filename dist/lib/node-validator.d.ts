/**
 * Validates a conversation flow JSON structure before pushing to Retell.
 * Returns an array of errors — empty means valid.
 */
export interface ValidationError {
    code: string;
    message: string;
    nodeId?: string;
    field?: string;
}
export declare function validateConversationFlow(flow: Record<string, unknown>): ValidationError[];
