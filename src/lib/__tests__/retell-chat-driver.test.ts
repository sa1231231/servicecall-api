import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocked Retell SDK ───────────────────────────────────────────────────────

const { mockAgentRetrieve, mockChatAgentCreate, mockChatAgentDelete, mockChatCreate, mockChatCompletion, mockChatEnd, mockChatRetrieve } = vi.hoisted(() => ({
  mockAgentRetrieve: vi.fn(),
  mockChatAgentCreate: vi.fn(),
  mockChatAgentDelete: vi.fn(),
  mockChatCreate: vi.fn(),
  mockChatCompletion: vi.fn(),
  mockChatEnd: vi.fn(),
  mockChatRetrieve: vi.fn(),
}));

vi.mock("retell-sdk", () => ({
  default: class {
    agent = { retrieve: mockAgentRetrieve };
    chatAgent = { create: mockChatAgentCreate, delete: mockChatAgentDelete };
    chat = {
      create: mockChatCreate,
      createChatCompletion: mockChatCompletion,
      end: mockChatEnd,
      retrieve: mockChatRetrieve,
    };
  },
}));

// Module under test imported AFTER mocks
const { createChatCloneFromVoiceAgent, deleteChatAgent, startChat, sendUserMessage, endChat } =
  await import("../retell-chat-driver.js");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RETELL_API_KEY = "test-key";
});

describe("client init", () => {
  it("throws a clear error when RETELL_API_KEY is unset", async () => {
    delete process.env.RETELL_API_KEY;
    await expect(startChat("agent_x")).rejects.toThrow(/RETELL_API_KEY/);
  });
});

describe("createChatCloneFromVoiceAgent", () => {
  it("clones a voice agent's conversation_flow_id into a new chat agent", async () => {
    mockAgentRetrieve.mockResolvedValue({
      response_engine: { type: "conversation-flow", conversation_flow_id: "flow_123" },
    });
    mockChatAgentCreate.mockResolvedValue({ agent_id: "chat_456" });

    const id = await createChatCloneFromVoiceAgent("voice_1", "Test Chat");
    expect(id).toBe("chat_456");
    expect(mockAgentRetrieve).toHaveBeenCalledWith("voice_1");
    expect(mockChatAgentCreate).toHaveBeenCalledWith({
      response_engine: { type: "conversation-flow", conversation_flow_id: "flow_123" },
      agent_name: "Test Chat",
    });
  });

  it("rejects when the source voice agent isn't a conversation-flow agent", async () => {
    mockAgentRetrieve.mockResolvedValue({
      response_engine: { type: "retell-llm", llm_id: "llm_1" },
    });
    await expect(createChatCloneFromVoiceAgent("voice_1", "Test")).rejects.toThrow(
      /not a conversation-flow agent/,
    );
    expect(mockChatAgentCreate).not.toHaveBeenCalled();
  });
});

describe("deleteChatAgent", () => {
  it("calls SDK delete with the given agent id", async () => {
    mockChatAgentDelete.mockResolvedValue({});
    await deleteChatAgent("chat_456");
    expect(mockChatAgentDelete).toHaveBeenCalledWith("chat_456");
  });
});

describe("startChat", () => {
  it("returns chatId and only the agent's opening messages", async () => {
    mockChatCreate.mockResolvedValue({
      chat_id: "chat_1",
      message_with_tool_calls: [
        { role: "agent", content: "Hello!" },
        { role: "node_transition", new_node_name: "Intro" }, // not a content message
        { role: "agent", content: "How can I help?" },
        { role: "user", content: "should be ignored" },
      ],
    });

    const result = await startChat("agent_x", { caller_name: "Sam" });
    expect(result.chatId).toBe("chat_1");
    expect(result.openingMessages).toEqual(["Hello!", "How can I help?"]);
    expect(mockChatCreate).toHaveBeenCalledWith({
      agent_id: "agent_x",
      retell_llm_dynamic_variables: { caller_name: "Sam" },
    });
  });

  it("handles an empty message_with_tool_calls", async () => {
    mockChatCreate.mockResolvedValue({ chat_id: "chat_2" });
    const result = await startChat("agent_x");
    expect(result.openingMessages).toEqual([]);
  });
});

describe("sendUserMessage", () => {
  it("returns separated agent messages and node transitions", async () => {
    mockChatCompletion.mockResolvedValue({
      messages: [
        { role: "node_transition", former_node_name: "Intro", new_node_name: "Collect Name" },
        { role: "agent", content: "What's your name?" },
        { role: "agent", content: "Take your time." },
      ],
    });
    const turn = await sendUserMessage("chat_1", "hi");
    expect(turn.agentMessages).toEqual(["What's your name?", "Take your time."]);
    expect(turn.nodeTransitions).toEqual([{ from: "Intro", to: "Collect Name" }]);
    expect(turn.ended).toBe(false);
  });

  it("returns a synthetic ended=true turn when the SDK reports the chat already ended", async () => {
    mockChatCompletion.mockRejectedValue(new Error("Chat has already ended"));
    const turn = await sendUserMessage("chat_1", "hi");
    expect(turn.ended).toBe(true);
    expect(turn.agentMessages).toEqual(["<chat ended by agent>"]);
  });

  it("re-throws unrelated SDK errors instead of swallowing them", async () => {
    mockChatCompletion.mockRejectedValue(new Error("Network unreachable"));
    await expect(sendUserMessage("chat_1", "hi")).rejects.toThrow(/Network unreachable/);
  });
});

describe("endChat", () => {
  it("ends the chat and returns aggregated visited nodes + collected variables", async () => {
    mockChatEnd.mockResolvedValue({});
    mockChatRetrieve.mockResolvedValue({
      chat_status: "ended",
      collected_dynamic_variables: { first_name: "Sam" },
      transcript: "Agent: hi\nUser: hi",
      message_with_tool_calls: [
        { role: "node_transition", new_node_name: "Intro" },
        { role: "agent", content: "Hi!" },
        { role: "node_transition", new_node_name: "Collect Name" },
      ],
    });

    const result = await endChat("chat_1");
    expect(mockChatEnd).toHaveBeenCalledWith("chat_1");
    expect(result.status).toBe("ended");
    expect(result.collectedVariables).toEqual({ first_name: "Sam" });
    expect(result.visitedNodes).toEqual(["Intro", "Collect Name"]);
    expect(result.transcript).toContain("Agent");
  });

  it("swallows 'already ended' on chat.end but still retrieves final state", async () => {
    mockChatEnd.mockRejectedValue(new Error("Chat has already ended"));
    mockChatRetrieve.mockResolvedValue({
      chat_status: "ended",
      collected_dynamic_variables: {},
      transcript: "",
      message_with_tool_calls: [],
    });

    const result = await endChat("chat_1");
    expect(result.status).toBe("ended");
    expect(mockChatRetrieve).toHaveBeenCalledWith("chat_1");
  });

  it("re-throws non-already-ended errors from chat.end", async () => {
    mockChatEnd.mockRejectedValue(new Error("Boom"));
    await expect(endChat("chat_1")).rejects.toThrow(/Boom/);
    expect(mockChatRetrieve).not.toHaveBeenCalled();
  });

  it("defaults collected_dynamic_variables to empty object when SDK omits it", async () => {
    mockChatEnd.mockResolvedValue({});
    mockChatRetrieve.mockResolvedValue({
      chat_status: "ended",
      transcript: "",
      message_with_tool_calls: [],
    });
    const result = await endChat("chat_1");
    expect(result.collectedVariables).toEqual({});
  });
});
