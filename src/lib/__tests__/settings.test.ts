import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockFindOne = vi.fn();
const mockUpdateOne = vi.fn();

vi.mock("../db.js", () => ({
  getDb: () => ({
    collection: () => ({
      findOne: mockFindOne,
      updateOne: mockUpdateOne,
    }),
  }),
}));

vi.mock("../../config/notification-clients.js", () => ({
  setOwnerConfig: vi.fn(),
}));

import { getSettings, updateSettings } from "../settings.js";
import { setOwnerConfig } from "../../config/notification-clients.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateOne.mockResolvedValue({});
});

// ── getSettings ────────────────────────────────────────────────────────────

describe("getSettings", () => {
  it("returns empty strings when no document exists", async () => {
    mockFindOne.mockResolvedValue(null);
    const settings = await getSettings();

    expect(settings.google_review_url).toBe("");
    expect(settings.review_sms_message).toBe("");
    expect(settings.stripe_payment_url).toBe("");
    expect(settings.payment_sms_message).toBe("");
    expect(settings.portal_sms_message).toBe("");
    expect(settings.owner_email).toBe("");
    expect(settings.owner_phone).toBe("");
    expect(settings.free_trial_days).toBe(0);
  });

  it("does not use hardcoded fallback messages", async () => {
    mockFindOne.mockResolvedValue(null);
    const settings = await getSettings();

    // Should NOT contain any default template text
    expect(settings.review_sms_message).not.toContain("Google review");
    expect(settings.payment_sms_message).not.toContain("subscribe");
    expect(settings.portal_sms_message).not.toContain("portal");
    expect(settings.owner_email).not.toContain("@");
    expect(settings.owner_phone).not.toContain("+");
  });

  it("returns values from MongoDB document", async () => {
    mockFindOne.mockResolvedValue({
      _id: "global",
      google_review_url: "https://g.page/test",
      review_sms_message: "Custom review msg",
      stripe_payment_url: "https://stripe.test",
      payment_sms_message: "Custom payment msg",
      portal_sms_message: "Custom portal msg",
      free_trial_days: 21,
      owner_email: "owner@test.com",
      owner_phone: "+15551234567",
    });
    const settings = await getSettings();

    expect(settings.google_review_url).toBe("https://g.page/test");
    expect(settings.review_sms_message).toBe("Custom review msg");
    expect(settings.stripe_payment_url).toBe("https://stripe.test");
    expect(settings.payment_sms_message).toBe("Custom payment msg");
    expect(settings.portal_sms_message).toBe("Custom portal msg");
    expect(settings.free_trial_days).toBe(21);
    expect(settings.owner_email).toBe("owner@test.com");
    expect(settings.owner_phone).toBe("+15551234567");
  });

  it("returns empty string for missing fields in partial document", async () => {
    mockFindOne.mockResolvedValue({
      _id: "global",
      owner_email: "test@test.com",
      // All other fields missing
    });
    const settings = await getSettings();

    expect(settings.owner_email).toBe("test@test.com");
    expect(settings.google_review_url).toBe("");
    expect(settings.portal_sms_message).toBe("");
    expect(settings.free_trial_days).toBe(0);
  });
});

// ── updateSettings ─────────────────────────────────────────────────────────

describe("updateSettings", () => {
  it("updates only provided fields", async () => {
    mockFindOne.mockResolvedValue({
      _id: "global",
      owner_email: "updated@test.com",
    });

    await updateSettings({ owner_email: "updated@test.com" });

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    const setArg = mockUpdateOne.mock.calls[0][1].$set;
    expect(setArg).toEqual({ owner_email: "updated@test.com" });
  });

  it("does not update when given empty object", async () => {
    mockFindOne.mockResolvedValue({ _id: "global" });

    await updateSettings({});

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("updates portal_sms_message", async () => {
    mockFindOne.mockResolvedValue({
      _id: "global",
      portal_sms_message: "New portal msg",
    });

    await updateSettings({ portal_sms_message: "New portal msg" });

    const setArg = mockUpdateOne.mock.calls[0][1].$set;
    expect(setArg.portal_sms_message).toBe("New portal msg");
  });

  it("calls setOwnerConfig after update", async () => {
    mockFindOne.mockResolvedValue({
      _id: "global",
      owner_email: "a@b.com",
      owner_phone: "+1555",
    });

    await updateSettings({ owner_email: "a@b.com" });

    expect(setOwnerConfig).toHaveBeenCalledWith("a@b.com", "+1555");
  });

  it("handles all fields at once", async () => {
    mockFindOne.mockResolvedValue({ _id: "global" });

    await updateSettings({
      google_review_url: "url1",
      review_sms_message: "msg1",
      stripe_payment_url: "url2",
      payment_sms_message: "msg2",
      portal_sms_message: "msg3",
      free_trial_days: 30,
      owner_email: "e@e.com",
      owner_phone: "+1",
    });

    const setArg = mockUpdateOne.mock.calls[0][1].$set;
    expect(Object.keys(setArg)).toHaveLength(8);
  });
});
