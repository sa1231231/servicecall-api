import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockRetellPhoneList,
  mockRetellPhoneDelete,
  mockRetellAgentDelete,
  mockRetellFlowDelete,
  mockTwilioMsgRemove,
  mockTwilioTrunkRemove,
  mockTwilioIncomingRemove,
  mockTwilioIncomingUpdate,
  mockLogPhoneEvent,
  mockHistoryFindArray,
} = vi.hoisted(() => ({
  mockRetellPhoneList: vi.fn(),
  mockRetellPhoneDelete: vi.fn(),
  mockRetellAgentDelete: vi.fn(),
  mockRetellFlowDelete: vi.fn(),
  mockTwilioMsgRemove: vi.fn(),
  mockTwilioTrunkRemove: vi.fn(),
  mockTwilioIncomingRemove: vi.fn(),
  mockTwilioIncomingUpdate: vi.fn(),
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
    phoneNumber = { list: mockRetellPhoneList, delete: mockRetellPhoneDelete };
    agent = { delete: mockRetellAgentDelete };
    conversationFlow = { delete: mockRetellFlowDelete };
  },
}));

vi.mock("twilio", () => ({
  default: () => ({
    incomingPhoneNumbers: (sid: string) => ({
      remove: () => mockTwilioIncomingRemove(sid),
      update: (params: any) => mockTwilioIncomingUpdate(sid, params),
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
  // History → SID lookup is mocked directly now (the helper used to query
  // db.js inline; it's been factored into phone-number-history.js).
  // mockHistoryFindArray returns an array of provisioned events; pull the
  // first one's sid to mimic the new lookupSidFromHistory shape.
  lookupSidFromHistory: async (..._a: any[]) => {
    const events = await mockHistoryFindArray();
    return events[0]?.phone_number_sid || null;
  },
}));

const { releaseAgentResources } = await import("../release-agent-resources.js");

// ── Helpers ────────────────────────────────────────────────────────────────

beforeEach(() => {
  for (const m of [
    mockRetellPhoneList, mockRetellPhoneDelete, mockRetellAgentDelete,
    mockRetellFlowDelete, mockTwilioMsgRemove, mockTwilioTrunkRemove,
    mockTwilioIncomingRemove, mockTwilioIncomingUpdate, mockLogPhoneEvent,
    mockHistoryFindArray,
  ]) m.mockReset();
  // Sensible defaults: every external call resolves OK; no Retell numbers,
  // no SID history.
  mockRetellPhoneList.mockResolvedValue([]);
  mockRetellPhoneDelete.mockResolvedValue(undefined);
  mockRetellAgentDelete.mockResolvedValue(undefined);
  mockRetellFlowDelete.mockResolvedValue(undefined);
  mockTwilioMsgRemove.mockResolvedValue(true);
  mockTwilioTrunkRemove.mockResolvedValue(true);
  mockTwilioIncomingRemove.mockResolvedValue(true);
  mockTwilioIncomingUpdate.mockResolvedValue(true);
  mockLogPhoneEvent.mockResolvedValue(undefined);
  mockHistoryFindArray.mockResolvedValue([]);
});

function inboundBinding(phone: string, agentId: string) {
  return { phone_number: phone, inbound_agents: [{ agent_id: agentId }] };
}
function outboundBinding(phone: string, agentId: string) {
  return { phone_number: phone, inbound_agents: [], outbound_agents: [{ agent_id: agentId }] };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("releaseAgentResources — Retell-live source of truth", () => {
  it("releases each currently-bound phone number across Retell and Twilio", async () => {
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
      inboundBinding("+15550002222", "agent_x"),
    ]);
    // SID lookup returns the matching SID for each phone in turn.
    mockHistoryFindArray
      .mockResolvedValueOnce([{ phone_number_sid: "PN_a" }])
      .mockResolvedValueOnce([{ phone_number_sid: "PN_b" }]);

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(mockRetellPhoneDelete).toHaveBeenCalledWith("+15550001111");
    expect(mockRetellPhoneDelete).toHaveBeenCalledWith("+15550002222");
    expect(mockTwilioMsgRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioMsgRemove).toHaveBeenCalledWith("PN_b");
    expect(mockTwilioTrunkRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioTrunkRemove).toHaveBeenCalledWith("PN_b");
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_b");
    expect(mockLogPhoneEvent).toHaveBeenCalledWith("acme", "+15550001111", "PN_a", "released");
    expect(mockLogPhoneEvent).toHaveBeenCalledWith("acme", "+15550002222", "PN_b", "released");

    expect(result.released).toEqual([
      { phone_number: "+15550001111", phone_number_sid: "PN_a" },
      { phone_number: "+15550002222", phone_number_sid: "PN_b" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("releases outbound-only bindings too", async () => {
    mockRetellPhoneList.mockResolvedValue([
      outboundBinding("+15553334444", "agent_x"),
    ]);
    mockHistoryFindArray.mockResolvedValue([{ phone_number_sid: "PN_o" }]);

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_o");
    expect(result.released).toEqual([
      { phone_number: "+15553334444", phone_number_sid: "PN_o" },
    ]);
  });

  it("does NOT release numbers that are no longer bound in Retell at delete-time", async () => {
    // Retell shows no bindings for our agent (manually unbound earlier).
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15559999999", "agent_other"), // someone else's number
    ]);
    // History still has us as the prior owner — should be ignored.
    mockHistoryFindArray.mockResolvedValue([{ phone_number_sid: "PN_old" }]);

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(mockRetellPhoneDelete).not.toHaveBeenCalled();
    expect(mockTwilioIncomingRemove).not.toHaveBeenCalled();
    expect(result.released).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("filters by every agent_id the slug owns (doc.agent_id + retell_agents map)", async () => {
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_a"),
      inboundBinding("+15550002222", "agent_b"),
      inboundBinding("+15559999999", "agent_unrelated"),
    ]);
    mockHistoryFindArray
      .mockResolvedValueOnce([{ phone_number_sid: "PN_a" }])
      .mockResolvedValueOnce([{ phone_number_sid: "PN_b" }]);

    const result = await releaseAgentResources("acme", {
      agent_id: "agent_a",
      retell_agents: { agent_b: {} },
    });

    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_b");
    // The unrelated number is left alone.
    expect(mockTwilioIncomingRemove).not.toHaveBeenCalledWith("PN_x");
    expect(result.released).toHaveLength(2);
  });

  it("captures per-step Twilio failures and keeps releasing the rest", async () => {
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
      inboundBinding("+15550002222", "agent_x"),
    ]);
    mockHistoryFindArray
      .mockResolvedValueOnce([{ phone_number_sid: "PN_a" }])
      .mockResolvedValueOnce([{ phone_number_sid: "PN_b" }]);
    // Trunk detach fails for the first SID.
    mockTwilioTrunkRemove.mockImplementation((sid: string) => {
      if (sid === "PN_a") return Promise.reject(new Error("trunk error"));
      return Promise.resolve(true);
    });

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    // Both still get the incoming-number release (the billing cutoff).
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_b");
    expect(result.released).toHaveLength(2);
    expect(result.errors.some((e) => /trunk detach \(\+15550001111\)/.test(e))).toBe(true);
  });

  it("silences Twilio 20404/404 on detach (already detached)", async () => {
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
    ]);
    mockHistoryFindArray.mockResolvedValue([{ phone_number_sid: "PN_a" }]);
    mockTwilioMsgRemove.mockRejectedValue(new Error("HTTP 404 — code 20404 — not found"));

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(mockTwilioIncomingRemove).toHaveBeenCalled();
    expect(result.released).toHaveLength(1);
    expect(result.errors).toEqual([]); // 20404 not surfaced
  });

  it("silences Twilio 404 on incoming release and still logs the released event", async () => {
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
    ]);
    mockHistoryFindArray.mockResolvedValue([{ phone_number_sid: "PN_a" }]);
    mockTwilioIncomingRemove.mockRejectedValue(new Error("HTTP 404 — not found"));

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    // No surface error for already-released number.
    expect(result.errors).toEqual([]);
    // Audit-log still fires so getNumberDaysInRange closes the billing window.
    expect(mockLogPhoneEvent).toHaveBeenCalledWith("acme", "+15550001111", "PN_a", "released");
    // Not added to `released` array because the actual remove() call rejected.
    expect(result.released).toEqual([]);
  });

  it("when Retell-bound number has no SID in history, flags the gap and skips Twilio", async () => {
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
    ]);
    mockHistoryFindArray.mockResolvedValue([]); // no provisioned event recorded

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    // Retell binding still cleared.
    expect(mockRetellPhoneDelete).toHaveBeenCalledWith("+15550001111");
    // Twilio side skipped.
    expect(mockTwilioIncomingRemove).not.toHaveBeenCalled();
    expect(mockTwilioMsgRemove).not.toHaveBeenCalled();
    expect(mockTwilioTrunkRemove).not.toHaveBeenCalled();
    expect(result.released).toEqual([]);
    expect(result.errors.some((e) => /no Twilio SID/.test(e))).toBe(true);
  });

  it("when retell.phoneNumber.list itself fails, captures the error and continues with agent cleanup", async () => {
    mockRetellPhoneList.mockRejectedValue(new Error("retell list down"));

    const result = await releaseAgentResources("acme", {
      agent_id: "agent_x",
      retell_agents: { agent_x: {} },
    });

    // No phone-side cleanup attempted.
    expect(mockRetellPhoneDelete).not.toHaveBeenCalled();
    expect(mockTwilioIncomingRemove).not.toHaveBeenCalled();
    // Agent still gets cleaned up.
    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_x");
    expect(result.errors.some((e) => /retell\.phoneNumber\.list/.test(e))).toBe(true);
  });

  it("silences 404 on retell.phoneNumber.delete (binding already gone)", async () => {
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
    ]);
    mockHistoryFindArray.mockResolvedValue([{ phone_number_sid: "PN_a" }]);
    mockRetellPhoneDelete.mockRejectedValue(new Error("HTTP 404 — not found"));

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    // Twilio side still proceeds despite the binding being absent.
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    expect(result.released).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("clears emergency address before releasing the Twilio number", async () => {
    // Twilio blocks .remove() on numbers with an emergency address
    // attached. Pre-release update({emergencyStatus, emergencyAddressSid})
    // unbinds it so the release lands cleanly without operator hops.
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
    ]);
    mockHistoryFindArray.mockResolvedValue([{ phone_number_sid: "PN_a" }]);

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(mockTwilioIncomingUpdate).toHaveBeenCalledWith("PN_a", {
      emergencyStatus: "Inactive",
      emergencyAddressSid: "",
    });
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    // The update fires BEFORE the remove (order matters — Twilio's gate).
    const updateOrder = mockTwilioIncomingUpdate.mock.invocationCallOrder[0];
    const removeOrder = mockTwilioIncomingRemove.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(removeOrder);
    expect(result.released).toHaveLength(1);
  });

  it("when emergency-clear fails, still attempts the release (best-effort)", async () => {
    // The pre-release update is informational — a 500 from Twilio's
    // address-unbind endpoint shouldn't abort the release. The .remove()
    // call surfaces any real remaining blocker on its own.
    mockRetellPhoneList.mockResolvedValue([
      inboundBinding("+15550001111", "agent_x"),
    ]);
    mockHistoryFindArray.mockResolvedValue([{ phone_number_sid: "PN_a" }]);
    mockTwilioIncomingUpdate.mockRejectedValue(new Error("Twilio 500"));

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    // Update was attempted, but remove still ran and succeeded.
    expect(mockTwilioIncomingUpdate).toHaveBeenCalled();
    expect(mockTwilioIncomingRemove).toHaveBeenCalledWith("PN_a");
    expect(result.released).toHaveLength(1);
    // The update failure is a console warning, not a release-blocking
    // error — `errors` stays clean of remove-side messages.
    expect(result.errors.some((e: string) => /twilio release/.test(e))).toBe(false);
  });
});

describe("releaseAgentResources — Retell agent + flow cleanup", () => {
  it("deletes every agent in retell_agents and their conversation flows", async () => {
    mockRetellPhoneList.mockResolvedValue([]);
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
    await releaseAgentResources("acme", { agent_id: "agent_legacy" });
    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_legacy");
  });

  it("does not double-delete when doc.agent_id is already in retell_agents map", async () => {
    await releaseAgentResources("acme", {
      agent_id: "agent_a",
      retell_agents: { agent_a: {} },
    });
    expect(mockRetellAgentDelete).toHaveBeenCalledTimes(1);
    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_a");
  });

  it("silences 404 on agent.delete (operator already removed it manually)", async () => {
    mockRetellAgentDelete.mockRejectedValue(new Error("HTTP 404 — not found"));

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(mockRetellAgentDelete).toHaveBeenCalledWith("agent_x");
    expect(result.errors).toEqual([]); // 404 silenced
  });

  it("surfaces non-404 retell.agent.delete failures into errors", async () => {
    mockRetellAgentDelete.mockRejectedValue(new Error("retell down"));

    const result = await releaseAgentResources("acme", { agent_id: "agent_x" });

    expect(result.errors.some((e) => /retell\.agent\.delete\(agent_x\): retell down/.test(e))).toBe(true);
  });
});
