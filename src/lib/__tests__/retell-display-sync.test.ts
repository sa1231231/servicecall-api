import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncRetellDisplayLabels } from "../retell-display-sync.js";

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
  beforeEach(() => { vi.clearAllMocks(); });

  it("updates agent_name and every nickname for inbound-bound numbers", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+18159990000", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const agentUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ agentUpdate, phoneList, phoneUpdate });

    const result = await syncRetellDisplayLabels(retell, "agent_1", null, "Beta Plumbing");

    expect(agentUpdate).toHaveBeenCalledWith("agent_1", { agent_name: "Beta Plumbing" });
    expect(phoneUpdate).toHaveBeenCalledTimes(2);
    expect(phoneUpdate).toHaveBeenCalledWith("+18158804070", { nickname: "Beta Plumbing" });
    expect(phoneUpdate).toHaveBeenCalledWith("+18159990000", { nickname: "Beta Plumbing" });
    expect(result).toEqual({
      agentNameUpdated: true,
      nicknameUpdated: ["+18158804070", "+18159990000"],
      nicknameErrors: [],
    });
  });

  it("includes outbound_from_number fallback when not bound inbound", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+15550000000", inbound_agents: [] }, // outbound-only fallback
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });

    const result = await syncRetellDisplayLabels(retell, "agent_1", "+15550000000", "Acme");

    expect(phoneUpdate).toHaveBeenCalledTimes(2);
    expect(phoneUpdate).toHaveBeenCalledWith("+15550000000", { nickname: "Acme" });
    expect(result.nicknameUpdated).toEqual(["+18158804070", "+15550000000"]);
    expect(result.nicknameErrors).toEqual([]);
  });

  it("ignores numbers bound to a different agent", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+15559999999", inbound_agents: [{ agent_id: "agent_other", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });

    const result = await syncRetellDisplayLabels(retell, "agent_1", null, "Acme");

    expect(phoneUpdate).toHaveBeenCalledTimes(1);
    expect(phoneUpdate).toHaveBeenCalledWith("+18158804070", { nickname: "Acme" });
    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
  });

  it("collects per-number errors and continues with the rest", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
      { phone_number: "+18159990000", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("retell rejected"));
    const retell = makeRetell({ phoneList, phoneUpdate });

    const result = await syncRetellDisplayLabels(retell, "agent_1", null, "Acme");

    expect(result.agentNameUpdated).toBe(true);
    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
    expect(result.nicknameErrors).toEqual(["+18159990000: retell rejected"]);
  });

  it("survives phoneNumber.list() failure with agent_name still updated", async () => {
    const agentUpdate = vi.fn().mockResolvedValue(undefined);
    const phoneList = vi.fn().mockRejectedValue(new Error("retell list down"));
    const phoneUpdate = vi.fn();
    const retell = makeRetell({ agentUpdate, phoneList, phoneUpdate });

    const result = await syncRetellDisplayLabels(retell, "agent_1", null, "Acme");

    expect(agentUpdate).toHaveBeenCalledWith("agent_1", { agent_name: "Acme" });
    expect(phoneUpdate).not.toHaveBeenCalled();
    expect(result).toEqual({
      agentNameUpdated: true,
      nicknameUpdated: [],
      nicknameErrors: ["list: retell list down"],
    });
  });

  it("with null outbound_from_number, only inbound bindings match", async () => {
    const phoneList = vi.fn().mockResolvedValue([
      { phone_number: "+15550000000", inbound_agents: [] }, // would be skipped without outbound fallback
      { phone_number: "+18158804070", inbound_agents: [{ agent_id: "agent_1", weight: 1 }] },
    ]);
    const phoneUpdate = vi.fn().mockResolvedValue(undefined);
    const retell = makeRetell({ phoneList, phoneUpdate });

    const result = await syncRetellDisplayLabels(retell, "agent_1", null, "Acme");

    expect(phoneUpdate).toHaveBeenCalledTimes(1);
    expect(phoneUpdate).toHaveBeenCalledWith("+18158804070", { nickname: "Acme" });
    expect(result.nicknameUpdated).toEqual(["+18158804070"]);
  });

  it("propagates agent.update failures (no nicknames touched)", async () => {
    const agentUpdate = vi.fn().mockRejectedValue(new Error("agent gone"));
    const phoneList = vi.fn();
    const phoneUpdate = vi.fn();
    const retell = makeRetell({ agentUpdate, phoneList, phoneUpdate });

    await expect(
      syncRetellDisplayLabels(retell, "agent_1", null, "Acme"),
    ).rejects.toThrow("agent gone");

    expect(phoneList).not.toHaveBeenCalled();
    expect(phoneUpdate).not.toHaveBeenCalled();
  });
});
