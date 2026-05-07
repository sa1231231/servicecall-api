import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockRetellPhoneDelete,
  mockRetellAgentDelete,
  mockRetellFlowDelete,
  mockTwilioMsgRemove,
  mockTwilioTrunkRemove,
  mockTwilioIncomingRemove,
  mockLogPhoneEvent,
  mockHistoryFindArray,
} = vi.hoisted(() => ({
  mockRetellPhoneDelete: vi.fn(),
  mockRetellAgentDelete: vi.fn(),
  mockRetellFlowDelete: vi.fn(),
  mockTwilioMsgRemove: vi.fn(),
  mockTwilioTrunkRemove: vi.fn(),
  mockTwilioIncomingRemove: vi.fn(),
  mockLogPhoneEvent: vi.fn(),
  mockHistoryFindArray: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: {
    RETELL_API_KEY: "rk_test",
    TWILIO_ACCOUNT_SID: "AC_test",
    TWILIO_AUTH_TOKEN: "tok_test",
    TWILIO_TRUNK_SID: "TR_test",
    TWILIO_MESSAGING_SERVICE_SID: "MG_test",
  },
}));

vi.mock("retell-sdk", () => ({
  default: class {
    phoneNumber = { delete: mockRetellPhoneDelete };
    agent = { delete: mockRetellAgentDelete };
    conversationFlow = { delete: mockRetellFlowDelete };
  },
}));

vi.mock("twilio", () => ({
  default: () => ({
    incomingPhoneNumbers: (sid: string) => ({
      remove: () => mockTwilioIncomingRemove(sid),
    }),
    trunking: {
      v1: {
        trunks: (_trunkSid: string) => ({
          phoneNumbers: (sid: string) => ({
            remove: () => mockTwilioTrunkRemove(sid),
          }),
        }),
      },
    },
    messaging: {
      v1: {
        services: (_serviceSid: string) => ({
          phoneNumbers: (sid: string) => ({
            remove: () => mockTwilioMsgRemove(sid),
          }),
        }),
      },
    },
  }),
}));

vi.mock("../phone-number-history.js", () => ({
  logPhoneEvent: (...a: any[]) => mockLogPhoneEvent(...a),
}));

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      find: () => ({
        sort: () => ({ toArray: () => mockHistoryFindArray() }),
      }),
    }),
  }),
}));

const { releaseAgentResources } = await import("../release-agent-resources.js");

// ── Helpers ────────────────────────────────────────────────────────────────

beforeEach(() => {
  for (const m of [
    mockRetellPhoneDelete, mockRetellAgentDelete, mockRetellFlowDelete,
    mockTwilioMsgRemove, mockTwilioTrunkRemove, mockTwilioIncomingRemove,
    mockLogPhoneEvent, mockHistoryFindArray,
  ]) m.mockReset();
  // Sensible defaults: every external call resolves OK; no phone history.
  mockRetellPhoneDelete.mockResolvedValue(undefined);
  mockRetellAgentDelete.mockResolvedValue(undefined);
  mockRetellFlowDelete.mockResolvedValue(undefined);
  mockTwilioMsgRemove.mockResolvedValue(true);
  mockTwilioTrunkRemove.mockResolvedValue(true);
  mockTwilioIncomingRemove.mockResolvedValue(true);
  mockLogPhoneEvent.mockResolvedValue(undefined);
  mockHistoryFindArray.mockResolvedValue([]);
});

function provisionedEvent(phone: string, sid: string, at = new Date()) {
  return { client_slug: "acme", phone_number: phone, phone_number_sid: sid, event: "provisioned", at };
}
function releasedEvent(phone: string, sid: string, at = new Date()) {
  return { client_slug: "acme", phone_number: phone, phone_number_sid: sid, event: "released", at };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("releaseAgentResources — phone-number cleanup", () => {
  it("releases each currently-active phone number across Retell and Twilio", async () => {
    mockHistoryFindArray.mockResolvedValue([
      provisionedEvent("+15550001111", "PN_a"),
      provisionedEvent("+15550002222", "PN_b"),
    ]);

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    // Retell phone-number bindings deleted for both numbers
    expect(mockRetellPhoneDelete).toHaveBeenCalledWith("+15550001111");
    expect(mockRetellPhoneDelete).toHaveBeenCalledWith("+15550002222");
    // Twilio messaging-service detach (per-SID)
    expect(mockTwilioMsgRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioMsgRemove).toHaveBeenCalledWith("PN_b");
    // Twilio trunk detach (per-SID)
    expect(mockTwilioTrunkRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioTrunkRemove).toHaveBeenCalledWith("PN_b");
    // Twilio incoming-number release (the actual billing cutoff)
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_b");
    // History event logged for each
    expect(mockLogPhoneEvent).toHaveBeenCalledWith("acme", "+15550001111", "PN_a", "released");
    expect(mockLogPhoneEvent).toHaveBeenCalledWith("acme", "+15550002222", "PN_b", "released");

    expect(result.released).toEqual([
      { phone_number: "+15550001111", phone_number_sid: "PN_a" },
      { phone_number: "+15550002222", phone_number_sid: "PN_b" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("skips numbers that already have a `released` event after their last `provisioned`", async () => {
    mockHistoryFindArray.mockResolvedValue([
      provisionedEvent("+15550001111", "PN_a", new Date("2026-01-01")),
      releasedEvent("+15550001111", "PN_a", new Date("2026-02-01")),
      provisionedEvent("+15550002222", "PN_b", new Date("2026-03-01")),
    ]);

    const result = await releaseAgentResources("acme", {});

    // Only the still-active number gets touched
    expect(mockTwilioIncomingRemove).toHaveBeenCalledTimes(1);
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_b");
    expect(result.released).toEqual([
      { phone_number: "+15550002222", phone_number_sid: "PN_b" },
    ]);
  });

  it("captures per-step failures into errors but keeps releasing the rest", async () => {
    mockHistoryFindArray.mockResolvedValue([
      provisionedEvent("+15550001111", "PN_a"),
      provisionedEvent("+15550002222", "PN_b"),
    ]);
    // First number: trunk detach fails. Second number: clean.
    mockTwilioTrunkRemove.mockImplementation((sid: string) => {
      if (sid === "PN_a") return Promise.reject(new Error("trunk error"));
      return Promise.resolve(true);
    });

    const result = await releaseAgentResources("acme", {});

    // Both still get the incoming-number release (the billing cutoff),
    // because trunk-detach failure shouldn't block the rest.
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_b");
    expect(result.released).toHaveLength(2);
    expect(result.errors.some((e) => /trunk detach \(\+15550001111\)/.test(e))).toBe(true);
  });

  it("treats Twilio 20404 not-found errors on detach as informational (no error)", async () => {
    mockHistoryFindArray.mockResolvedValue([
      provisionedEvent("+15550001111", "PN_a"),
    ]);
    mockTwilioMsgRemove.mockRejectedValue(new Error("HTTP 404 — code 20404 — not found"));

    const result = await releaseAgentResources("acme", {});

    expect(mockTwilioIncomingRemove).toHaveBeenCalled();
    expect(result.released).toHaveLength(1);
    expect(result.errors).toEqual([]); // 20404 not surfaced
  });

  it("when phone_number_sid is missing on file, skips Twilio release and flags it", async () => {
    mockHistoryFindArray.mockResolvedValue([
      provisionedEvent("+15550001111", "" /* no SID */),
    ]);

    const result = await releaseAgentResources("acme", {});

    expect(mockTwilioIncomingRemove).not.toHaveBeenCalled();
    expect(mockTwilioMsgRemove).not.toHaveBeenCalled();
    expect(mockTwilioTrunkRemove).not.toHaveBeenCalled();
    // Retell binding still tried
    expect(mockRetellPhoneDelete).toHaveBeenCalledWith("+15550001111");
    expect(result.released).toEqual([]);
    expect(result.errors.some((e) => /no Twilio SID/.test(e))).toBe(true);
  });

  it("works when there are no phone numbers to release", async () => {
    mockHistoryFindArray.mockResolvedValue([]);

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(mockTwilioIncomingRemove).not.toHaveBeenCalled();
    // But Retell agent cleanup still runs
    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_x");
    expect(result.released).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("releaseAgentResources — Retell agent + flow cleanup", () => {
  it("deletes every agent in retell_agents and their conversation flows", async () => {
    mockHistoryFindArray.mockResolvedValue([]);
    const doc = {
      retell_agents: {
        agent_a: { conversationFlow: { conversation_flow_id: "flow_a" } },
        agent_b: { response_engine: { conversation_flow_id: "flow_b" } },
      },
    };

    await releaseAgentResources("acme", doc);

    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_a");
    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_b");
    expect(mockRetellFlowDelete).toHaveBeenCalledWith("flow_a");
    expect(mockRetellFlowDelete).toHaveBeenCalledWith("flow_b");
  });

  it("falls back to doc.agent_id when not present in retell_agents", async () => {
    mockHistoryFindArray.mockResolvedValue([]);

    await releaseAgentResources("acme", { agent_id: "agent_legacy" });

    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_legacy");
  });

  it("does not double-delete when doc.agent_id is already in retell_agents map", async () => {
    mockHistoryFindArray.mockResolvedValue([]);

    await releaseAgentResources("acme", {
      agent_id: "agent_a",
      retell_agents: { agent_a: {} },
    });

    expect(mockRetellAgentDelete).toHaveBeenCalledTimes(1);
    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_a");
  });

  it("collects retell delete failures into errors", async () => {
    mockHistoryFindArray.mockResolvedValue([]);
    mockRetellAgentDelete.mockRejectedValue(new Error("retell down"));

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(result.errors.some((e) => /retell\.agent\.delete\(agent_x\): retell down/.test(e))).toBe(true);
  });
});
