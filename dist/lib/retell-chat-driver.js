// Test-only utility: drives Retell chat agents end-to-end for the
// conversation-paths integration test. Not used by production routes.
import Retell from "retell-sdk";
function client() {
    const apiKey = process.env.RETELL_API_KEY;
    if (!apiKey)
        throw new Error("RETELL_API_KEY not set");
    return new Retell({ apiKey });
}
export async function createChatCloneFromVoiceAgent(voiceAgentId, name) {
    const c = client();
    const voice = await c.agent.retrieve(voiceAgentId);
    const engine = voice.response_engine;
    if (engine.type !== "conversation-flow") {
        throw new Error(`Voice agent ${voiceAgentId} is not a conversation-flow agent`);
    }
    const chatAgent = await c.chatAgent.create({
        response_engine: {
            type: "conversation-flow",
            conversation_flow_id: engine.conversation_flow_id,
        },
        agent_name: name,
    });
    return chatAgent.agent_id;
}
export async function deleteChatAgent(agentId) {
    await client().chatAgent.delete(agentId);
}
export async function startChat(agentId, dynamicVars) {
    const chat = await client().chat.create({
        agent_id: agentId,
        retell_llm_dynamic_variables: dynamicVars,
    });
    const opening = [];
    for (const m of chat.message_with_tool_calls ?? []) {
        if (m.role === "agent" && "content" in m)
            opening.push(m.content);
    }
    return { chatId: chat.chat_id, openingMessages: opening };
}
export async function sendUserMessage(chatId, content) {
    let resp;
    try {
        resp = await client().chat.createChatCompletion({ chat_id: chatId, content });
    }
    catch (e) {
        // Agent may auto-end the chat upon reaching a closing node; surface a synthetic
        // "ended" turn so the test runner can stop sending and proceed to assertions.
        if (/already ended/i.test(String(e?.message ?? ""))) {
            return { agentMessages: ["<chat ended by agent>"], nodeTransitions: [], ended: true };
        }
        throw e;
    }
    const agentMessages = [];
    const nodeTransitions = [];
    for (const m of resp.messages) {
        const role = m.role;
        if (role === "agent" && "content" in m) {
            agentMessages.push(m.content);
        }
        else if (role === "node_transition") {
            nodeTransitions.push({
                from: m.former_node_name,
                to: m.new_node_name,
            });
        }
    }
    return { agentMessages, nodeTransitions, ended: false };
}
export async function endChat(chatId) {
    const c = client();
    try {
        await c.chat.end(chatId);
    }
    catch (e) {
        // Agent may have auto-ended the chat upon reaching a closing node
        if (!/already ended/i.test(String(e?.message ?? "")))
            throw e;
    }
    const final = await c.chat.retrieve(chatId);
    const visited = [];
    for (const m of final.message_with_tool_calls ?? []) {
        if (m.role === "node_transition") {
            const name = m.new_node_name;
            if (name)
                visited.push(name);
        }
    }
    return {
        chatId,
        status: final.chat_status,
        collectedVariables: final.collected_dynamic_variables ?? {},
        transcript: final.transcript ?? "",
        visitedNodes: visited,
    };
}
