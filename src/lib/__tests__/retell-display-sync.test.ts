import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTwilioIncomingUpdate,
  mockLookupSidFromHistory,
} = vi.hoisted(() => ({
  mockTwilioIncomingUpdate: vi.fn(),
  mockLookupSidFromHistory: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: {
    TWILIO_ACCOUNT_SID: "AC_test",
    TWILIO_AUTH_TOKEN: "tok_test",
  },
}));

vi.mock("twilio", () => ({
  default: () => ({
    incomingPhoneNumbers: (sid: string) => ({
      update: (body: any) => mockTwilioIncomingUpdate(sid, body),
    }),
  }),
}));

vi.mock("../phone-number-history.js", () => ({
  lookupSidFromHistory: (...a: any[]) => mockLookupSidFromHistory(...a),
}));

const { syncRetellDisplayLabels } = await import("../retell-display-sync.js");

function makeRetell(overrides: {
  agentUpdate?: ReturnType<typeof vi.fn>;
  phoneList?: ReturnType<typeof vi.fn>;
  phoneUpdate?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    agent: { update: overrides.agentUpdate ?? vi.fn().mockResolvedValue(undefined) },
    phoneNumber: {
      list: overrides.phoneList ?? vi.fn().mockResolvedValue([]),
      update: overrides.phoneUpdate ?? vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

describe("syncRetellDisplayLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTwilioIncomingUpdate.mockResolvedValue({});
    mockLookupSidFromHistory.mockResolvedValue(null);
  });

  it("updates agent_name, every nickname, AND every Twilio friendlyName for inbound-bound numbers", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+18159990000", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const agentUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ agentUpdate, phoneList, phoneUpdate });
    mockLookupSidFromHistory
      .mockResolvedValueOnce("PN_a")
      .mockResolvedValueOnce("PN_b");

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Beta Plumbing");

    expect(agentUpdate).toHaveBeenCalledWith("agent_1", { agent_name: "Beta Plumbing" });
    expect(phoneUpdate).toHaveBeenCalledWith("+18158804070", { nickname: "Beta Plumbing" });
    expect(phoneUpdate).toHaveBeenCalledWith("+18159990000", { nickname: "Beta Plumbing" });
    expect(mockTwilioIncomingUpdate).toHaveBeenCalledWith("PN_a", { friendlyName: "Beta Plumbing" });
    expect(mockTwilioIncomingUpdate).toHaveBeenCalledWith("PN_b", { friendlyName: "Beta Plumbing" });
    expect(result).toEqual({
      agentNameUpdated: true,
      nicknameUpdated: ["+18158804070", "+18159990000"],
      nicknameErrors: [],
      friendlyNameUpdated: ["+18158804070", "+18159990000"],
      friendlyNameErrors: [],
    });
  });

  it("includes outbound_from_number fallback when not bound inbound", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+15550000000", inbound_agents: [] }, // outbound-only fallback
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });
    mockLookupSidFromHistory
      .mockResolvedValueOnce("PN_a")
      .mockResolvedValueOnce("PN_o");

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", "+15550000000", "Acme");

    expect(phoneUpdate).toHaveBeenCalledTimes(2);
    expect(mockTwilioIncomingUpdate).toHaveBeenCalledWith("PN_a", { friendlyName: "Acme" });
    expect(mockTwilioIncomingUpdate).toHaveBeenCalledWith("PN_o", { friendlyName: "Acme" });
    expect(result.nicknameUpdated).toEqual(["+18158804070", "+15550000000"]);
    expect(result.friendlyNameUpdated).toEqual(["+18158804070", "+15550000000"]);
  });

  it("ignores numbers bound to a different agent", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+15559999999", inbound_agents: [{ agent_id: "agent_other", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });
    mockLookupSidFromHistory.mockResolvedValueOnce("PN_a");

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Acme");

    expect(phoneUpdate).toHaveBeenCalledTimes(1);
    expect(phoneUpdate).toHaveBeenCalledWith("+18158804070", { nickname: "Acme" });
    expect(mockTwilioIncomingUpdate).toHaveBeenCalledTimes(1);
    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
    expect(result.friendlyNameUpdated).toEqual(["+18158804070"]);
  });

  it("collects per-number Retell errors and skips the Twilio update for that number", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+18159990000", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("retell rejected"));
    const retell = makeRetell({ phoneList, phoneUpdate });
    mockLookupSidFromHistory.mockResolvedValue("PN_a");

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Acme");

    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
    expect(result.nicknameErrors).toEqual(["+18159990000: retell rejected"]);
    // Twilio side only fires for the successful Retell update.
    expect(mockTwilioIncomingUpdate).toHaveBeenCalledTimes(1);
    expect(result.friendlyNameUpdated).toEqual(["+18158804070"]);
  });

  it("captures Twilio failures into friendlyNameErrors but still records the nickname success", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });
    mockLookupSidFromHistory.mockResolvedValue("PN_a");
    mockTwilioIncomingUpdate.mockRejectedValue(new Error("twilio rejected"));

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Acme");

    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
    expect(result.friendlyNameUpdated).toEqual([]);
    expect(result.friendlyNameErrors).toEqual(["+18158804070: twilio rejected"]);
  });

  it("flags missing Twilio SID and skips the friendlyName update", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });
    mockLookupSidFromHistory.mockResolvedValue(null);

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Acme");

    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
    expect(mockTwilioIncomingUpdate).not.toHaveBeenCalled();
    expect(result.friendlyNameErrors).toEqual([
      "+18158804070: no Twilio SID on file — friendlyName not updated",
    ]);
  });

  it("survives phoneNumber.list() failure with agent_name still updated", async () => {
    const agentUpdate = vi.fn().mockResolvedValue(undefined);
    const phoneList = vi.fn().mockRejectedValue(new Error("retell list down"));
    const phoneUpdate = vi.fn();
    const retell = makeRetell({ agentUpdate, phoneList, phoneUpdate });

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Acme");

    expect(agentUpdate).toHaveBeenCalledWith("agent_1", { agent_name: "Acme" });
    expect(phoneUpdate).not.toHaveBeenCalled();
    expect(mockTwilioIncomingUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({
      agentNameUpdated: true,
      nicknameUpdated: [],
      nicknameErrors: ["list: retell list down"],
      friendlyNameUpdated: [],
      friendlyNameErrors: [],
    });
  });

  it("with null outbound_from_number, only inbound bindings match", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+15550000000", inbound_agents: [] },
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });
    mockLookupSidFromHistory.mockResolvedValue("PN_a");

    const result = await syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Acme");

    expect(phoneUpdate).toHaveBeenCalledTimes(1);
    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
  });

  it("propagates agent.update failures (no nicknames or friendlyNames touched)", async () => {
    const agentUpdate = vi.fn().mockRejectedValue(new Error("agent gone"));
    const phoneList = vi.fn();
    const phoneUpdate = vi.fn();
    const retell = makeRetell({ agentUpdate, phoneList, phoneUpdate });

    await expect(
      syncRetellDisplayLabels(retell, "acme", "agent_1", null, "Acme"),
    ).rejects.toThrow("agent gone");

    expect(phoneList).not.toHaveBeenCalled();
    expect(phoneUpdate).not.toHaveBeenCalled();
    expect(mockTwilioIncomingUpdate).not.toHaveBeenCalled();
  });
});
