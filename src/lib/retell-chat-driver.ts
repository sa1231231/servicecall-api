import Retell from "retell-sdk";

export interface ChatTurn {
  agentMessages: string[];
  nodeTransitions: Array<{ from?: string; to?: string }>;
  ended?: boolean;
}

export interface ChatResult {
  chatId: string;
  status: "ongoing" | "ended" | "error";
  collectedVariables: Record<string, unknown>;
  transcript: string;
  visitedNodes: string[];
}

function client(): Retell {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) throw new Error("RETELL_API_KEY not set");
  return new Retell({ apiKey });
}

export async function createChatCloneFromVoiceAgent(
  voiceAgentId: string,
  name: string,
): Promise<string> {
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

export async function deleteChatAgent(agentId: string): Promise<void> {
  await client().chatAgent.delete(agentId);
}

export async function startChat(
  agentId: string,
  dynamicVars?: Record<string, string>,
): Promise<{ chatId: string; openingMessages: string[] }> {
  const chat = await client().chat.create({
    agent_id: agentId,
    retell_llm_dynamic_variables: dynamicVars,
  });
  const opening: string[] = [];
  for (const m of chat.message_with_tool_calls ?? []) {
    if ((m as any).role === "agent" && "content" in m) opening.push((m as any).content);
  }
  return { chatId: chat.chat_id, openingMessages: opening };
}

export async function sendUserMessage(chatId: string, content: string): Promise<ChatTurn> {
  let resp;
  try {
    resp = await client().chat.createChatCompletion({ chat_id: chatId, content });
  } catch (e: any) {
    // Agent may auto-end the chat upon reaching a closing node; surface a synthetic
    // "ended" turn so the test runner can stop sending and proceed to assertions.
    if (/already ended/i.test(String(e?.message ?? ""))) {
      return { agentMessages: ["<chat ended by agent>"], nodeTransitions: [], ended: true };
    }
    throw e;
  }
  const agentMessages: string[] = [];
  const nodeTransitions: Array<{ from?: string; to?: string }> = [];
  for (const m of resp.messages) {
    const role = (m as any).role;
    if (role === "agent" && "content" in m) {
      agentMessages.push((m as any).content);
    } else if (role === "node_transition") {
      nodeTransitions.push({
        from: (m as any).former_node_name,
        to: (m as any).new_node_name,
      });
    }
  }
  return { agentMessages, nodeTransitions, ended: false };
}

export async function endChat(chatId: string): Promise<ChatResult> {
  const c = client();
  try {
    await c.chat.end(chatId);
  } catch (e: any) {
    // Agent may have auto-ended the chat upon reaching a closing node
    if (!/already ended/i.test(String(e?.message ?? ""))) throw e;
  }
  const final = await c.chat.retrieve(chatId);
  const visited: string[] = [];
  for (const m of final.message_with_tool_calls ?? []) {
    if ((m as any).role === "node_transition") {
      const name = (m as any).new_node_name;
      if (name) visited.push(name);
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
