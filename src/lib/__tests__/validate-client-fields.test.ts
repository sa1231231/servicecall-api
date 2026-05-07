import { describe, it, expect } from "vitest";
import {
  validateClientFieldUpdates,
  validateGlobalSettingsUpdates,
} from "../validate-client-fields.js";

describe("validateClientFieldUpdates", () => {
  it("accepts a clean partial update", () => {
    expect(validateClientFieldUpdates({
      dispatch_text_numbers: ["+15551234567"],
      dispatch_email: ["ops@example.com"],
      dispatch_call_number: "+15551234567",
      webhook_url: "https://example.com/hook",
      display_name: "Acme Co",
    })).toEqual([]);
  });

  it("rejects non-E.164 dispatch_text_numbers", () => {
    const errs = validateClientFieldUpdates({
      dispatch_text_numbers: ["555-123-4567"],
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/E\.164/);
  });

  it("rejects malformed dispatch_email entry", () => {
    const errs = validateClientFieldUpdates({
      dispatch_email: ["not-an-email"],
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/valid email/);
  });

  it("rejects webhook_url without protocol", () => {
    const errs = validateClientFieldUpdates({
      webhook_url: "example.com/hook",
    });
    expect(errs).toContain("webhook_url: must start with https:// or http://");
  });

  it("allows empty webhook_url and contact fields (clearing)", () => {
    expect(validateClientFieldUpdates({
      webhook_url: "",
      contact_phone: "",
      contact_email: "",
    })).toEqual([]);
  });

  it("allows null contact fields", () => {
    expect(validateClientFieldUpdates({
      contact_phone: null,
      contact_email: null,
    })).toEqual([]);
  });

  it("caps display_name length", () => {
    const errs = validateClientFieldUpdates({
      display_name: "x".repeat(200),
    });
    expect(errs[0]).toMatch(/display_name.*120-character limit/);
  });

  it("validates dispatch_call_overrides keys and values", () => {
    const errs = validateClientFieldUpdates({
      dispatch_call_overrides: { "5551234567": "+15559999999" },
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toMatch(/E\.164/);
  });

  it("accepts a valid dispatch_call_overrides", () => {
    expect(validateClientFieldUpdates({
      dispatch_call_overrides: { "+15551112222": "+15553334444" },
    })).toEqual([]);
  });

  it("ignores unknown fields (whitelist enforcement is in updateClientFields)", () => {
    expect(validateClientFieldUpdates({ random_field: "anything" })).toEqual([]);
  });
});

describe("validateGlobalSettingsUpdates", () => {
  it("accepts well-formed settings", () => {
    expect(validateGlobalSettingsUpdates({
      google_review_url: "https://g.page/r/abc/review",
      stripe_payment_url: "https://buy.stripe.com/test",
      owner_email: "owner@example.com",
      owner_phone: "+15551234567",
      free_trial_days: 14,
    })).toEqual([]);
  });

  it("rejects invalid Stripe URL", () => {
    const errs = validateGlobalSettingsUpdates({
      stripe_payment_url: "ftp://buy.stripe.com/test",
    });
    expect(errs[0]).toMatch(/stripe_payment_url/);
  });

  it("rejects out-of-range free_trial_days", () => {
    expect(validateGlobalSettingsUpdates({ free_trial_days: -1 })[0]).toMatch(/free_trial_days/);
    expect(validateGlobalSettingsUpdates({ free_trial_days: 366 })[0]).toMatch(/free_trial_days/);
    expect(validateGlobalSettingsUpdates({ free_trial_days: "14" as unknown as number })[0]).toMatch(/free_trial_days/);
  });

  it("rejects setup_instructions missing label", () => {
    const errs = validateGlobalSettingsUpdates({
      setup_instructions: [{ id: "ins_1", label: "", message: "Hi" }],
    });
    expect(errs.join(" ")).toMatch(/label is required/);
  });

  it("caps SMS-body length to 1600 chars", () => {
    const errs = validateGlobalSettingsUpdates({
      review_sms_message: "x".repeat(1601),
    });
    expect(errs[0]).toMatch(/review_sms_message/);
  });
});
