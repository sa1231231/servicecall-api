export interface ChatTurn {
    agentMessages: string[];
    nodeTransitions: Array<{
        from?: string;
        to?: string;
    }>;
    ended?: boolean;
}
export interface ChatResult {
    chatId: string;
    status: "ongoing" | "ended" | "error";
    collectedVariables: Record<string, unknown>;
    transcript: string;
    visitedNodes: string[];
}
export declare function createChatCloneFromVoiceAgent(voiceAgentId: string, name: string): Promise<string>;
export declare function deleteChatAgent(agentId: string): Promise<void>;
export declare function startChat(agentId: string, dynamicVars?: Record<string, string>): Promise<{
    chatId: string;
    openingMessages: string[];
}>;
export declare function sendUserMessage(chatId: string, content: string): Promise<ChatTurn>;
export declare function endChat(chatId: string): Promise<ChatResult>;
