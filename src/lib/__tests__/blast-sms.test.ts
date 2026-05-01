import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const { mockNotificationClients } = vi.hoisted(() => ({
  mockNotificationClients: {} as Record<string, any>,
}));

vi.mock("../../_cache/clients.js", () => ({
  notificationClients: mockNotificationClients,
}));

const { mockSendSms } = vi.hoisted(() => ({
  mockSendSms: vi.fn(),
}));

vi.mock("../notify-sms.js", () => ({
  sendSms: (...args: any[]) => mockSendSms(...args),
}));

import {
  gatherRecipients,
  personalizeMessage,
  previewBlast,
  sendBlast,
} from "../blast-sms.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function addClient(slug: string, overrides: Record<string, any> = {}) {
  mockNotificationClients[slug] = {
    name: "Test " + slug,
    agent_id: "agent_" + slug,
    dispatch_text_numbers: ["+15550000001"],
    shadow_mode: false,
    active: undefined,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockNotificationClients)) delete mockNotificationClients[k];
  mockSendSms.mockResolvedValue({ sid: "SM_test" });
});

describe("personalizeMessage", () => {
  it("replaces {{client_name}} with client name", () => {
    expect(personalizeMessage("Hello {{client_name}}!", "Acme")).toBe("Hello Acme!");
  });

  it("replaces multiple occurrences", () => {
    expect(personalizeMessage("{{client_name}} - {{client_name}}", "Acme")).toBe("Acme - Acme");
  });

  it("is case-insensitive", () => {
    expect(personalizeMessage("{{CLIENT_NAME}}", "Acme")).toBe("Acme");
  });

  it("returns message unchanged when no placeholder", () => {
    expect(personalizeMessage("Hello world!", "Acme")).toBe("Hello world!");
  });

  it("does not replace partial matches like {{client_name_extra}}", () => {
    expect(personalizeMessage("{{client_name_extra}}", "Acme")).toBe("{{client_name_extra}}");
  });
});

describe("gatherRecipients", () => {
  it("collects numbers from active, non-shadow clients", () => {
    addClient("a", { dispatch_text_numbers: ["+15550000001", "+15550000002"] });
    addClient("b", { dispatch_text_numbers: ["+15550000003"] });

    const { recipients, clientCount } = gatherRecipients();
    expect(clientCount).toBe(2);
    expect(recipients).toHaveLength(3);
    expect(recipients.map((r) => r.number)).toEqual(["+15550000001", "+15550000002", "+15550000003"]);
  });

  it("skips shadow mode clients", () => {
    addClient("active", { dispatch_text_numbers: ["+15550000001"] });
    addClient("shadow", { dispatch_text_numbers: ["+15550000002"], shadow_mode: true });

    const { recipients, clientCount } = gatherRecipients();
    expect(clientCount).toBe(1);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].number).toBe("+15550000001");
  });

  it("skips inactive clients", () => {
    addClient("active", { dispatch_text_numbers: ["+15550000001"] });
    addClient("inactive", { dispatch_text_numbers: ["+15550000002"], active: false });

    const { recipients, clientCount } = gatherRecipients();
    expect(clientCount).toBe(1);
    expect(recipients).toHaveLength(1);
  });

  it("skips clients with no dispatch numbers", () => {
    addClient("nonum", { dispatch_text_numbers: [] });

    const { recipients, clientCount } = gatherRecipients();
    expect(clientCount).toBe(0);
    expect(recipients).toHaveLength(0);
  });

  it("includes explicitly active clients", () => {
    addClient("explicit", { active: true, dispatch_text_numbers: ["+15550000001"] });

    const { recipients, clientCount } = gatherRecipients();
    expect(clientCount).toBe(1);
    expect(recipients).toHaveLength(1);
  });

  it("includes client name with each recipient", () => {
    addClient("acme", { name: "Acme Plumbing", dispatch_text_numbers: ["+15550000001"] });

    const { recipients } = gatherRecipients();
    expect(recipients[0].clientName).toBe("Acme Plumbing");
  });
});

describe("previewBlast", () => {
  it("returns recipient count and sample message", () => {
    addClient("a", { name: "Acme Co", dispatch_text_numbers: ["+15550000001"] });
    addClient("b", { name: "Beta Inc", dispatch_text_numbers: ["+15550000002", "+15550000003"] });

    const preview = previewBlast("Hello {{client_name}}!");
    expect(preview.total_clients).toBe(2);
    expect(preview.total_recipients).toBe(3);
    expect(preview.sample_message).toBe("Hello Acme Co!");
  });

  it("uses fallback name when no clients exist", () => {
    const preview = previewBlast("Hello {{client_name}}!");
    expect(preview.total_recipients).toBe(0);
    expect(preview.sample_message).toBe("Hello Acme Co!");
  });
});

describe("sendBlast", () => {
  it("sends personalized SMS to each recipient", async () => {
    addClient("a", { name: "Acme", dispatch_text_numbers: ["+15550000001"] });
    addClient("b", { name: "Beta", dispatch_text_numbers: ["+15550000002"] });

    const result = await sendBlast("Hi {{client_name}}!");

    expect(mockSendSms).toHaveBeenCalledTimes(2);
    expect(mockSendSms).toHaveBeenCalledWith("+15550000001", "Hi Acme!");
    expect(mockSendSms).toHaveBeenCalledWith("+15550000002", "Hi Beta!");
    expect(result.sent).toBe(2);
    expect(result.failed).toHaveLength(0);
    expect(result.total_clients).toBe(2);
    expect(result.total_recipients).toBe(2);
  });

  it("collects failures without stopping", async () => {
    addClient("a", { dispatch_text_numbers: ["+15550000001"] });
    addClient("b", { dispatch_text_numbers: ["+15550000002"] });

    mockSendSms
      .mockResolvedValueOnce({ sid: "SM_ok" })
      .mockRejectedValueOnce(new Error("Twilio error"));

    const result = await sendBlast("Test message");

    expect(result.sent).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].number).toBe("+15550000002");
    expect(result.failed[0].error).toContain("Twilio error");
  });

  it("returns zero counts when no eligible clients", async () => {
    const result = await sendBlast("Test");

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.total_recipients).toBe(0);
  });

  it("handles all sends failing", async () => {
    addClient("a", { dispatch_text_numbers: ["+15550000001"] });
    addClient("b", { dispatch_text_numbers: ["+15550000002"] });

    mockSendSms.mockRejectedValue(new Error("Service down"));

    const result = await sendBlast("Test");

    expect(result.sent).toBe(0);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0].error).toContain("Service down");
    expect(result.failed[1].error).toContain("Service down");
  });

  it("sends plain message without placeholders identically", async () => {
    addClient("a", { name: "Acme", dispatch_text_numbers: ["+15550000001"] });
    addClient("b", { name: "Beta", dispatch_text_numbers: ["+15550000002"] });

    const result = await sendBlast("Happy holidays!");

    expect(mockSendSms).toHaveBeenCalledWith("+15550000001", "Happy holidays!");
    expect(mockSendSms).toHaveBeenCalledWith("+15550000002", "Happy holidays!");
    expect(result.sent).toBe(2);
  });
});
