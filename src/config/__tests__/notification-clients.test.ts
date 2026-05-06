import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ownerConfig, setOwnerConfig } from "../notification-clients.js";

describe("setOwnerConfig", () => {
  // Capture-and-restore is centralized so a failing assertion mid-test can't
  // leak the mutated singleton into sibling tests in the same worker.
  let originalEmail: string;
  let originalPhone: string;
  beforeEach(() => {
    originalEmail = ownerConfig.email;
    originalPhone = ownerConfig.phone;
  });
  afterEach(() => {
    setOwnerConfig(originalEmail, originalPhone);
  });

  it("mutates the exported ownerConfig email and phone", () => {
    setOwnerConfig("new@x.com", "+15551234567");
    expect(ownerConfig.email).toBe("new@x.com");
    expect(ownerConfig.phone).toBe("+15551234567");
  });

  it("ownerConfig retains the same object reference (so callers holding it stay live)", () => {
    const ref = ownerConfig;
    setOwnerConfig("a@b.com", "+10000000000");
    expect(ownerConfig).toBe(ref);
    expect(ref.email).toBe("a@b.com");
  });
});

// The previous "notificationClients" suite iterated over the in-memory cache
// to validate runtime client-doc shape. In the unit-test process that map is
// empty (no MongoDB load), so every for-of body was a no-op and every
// assertion passed vacuously. Deploy-time data validity is enforced by
// TypeScript types on JsonClientEntry plus the type-guarded loaders in
// loadClientsFromDb(); no runtime assertion is needed here.
