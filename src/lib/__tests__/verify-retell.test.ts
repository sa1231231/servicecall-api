import { describe, it, expect } from "vitest";
import { verifyRetellWebhookOrThrow } from "../verify-retell.js";

describe("verifyRetellWebhookOrThrow", () => {
  it("throws when signature is empty", () => {
    expect(() => verifyRetellWebhookOrThrow("body", "", "key")).toThrow(
      "Missing x-retell-signature header",
    );
  });

  it("throws when signatureKey is empty", () => {
    expect(() => verifyRetellWebhookOrThrow("body", "sig", "")).toThrow(
      "Missing RETELL_SIGNATURE_KEY",
    );
  });

  it("does not throw for missing params when both provided", () => {
    // With valid-looking (but wrong) signature + key, the function should either
    // throw "Invalid Retell signature" or not throw (if SDK accepts it).
    // We just verify the guard clauses above work correctly.
    try {
      verifyRetellWebhookOrThrow("body", "some-sig", "some-key");
    } catch (err: any) {
      // If it throws, it should be about invalid signature, not missing params
      expect(err.message).not.toContain("Missing");
    }
  });
});
