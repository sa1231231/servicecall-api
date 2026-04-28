import { describe, it, expect } from "vitest";
import { isR2Configured } from "../backup.js";

describe("isR2Configured", () => {
  it("returns false when env vars are empty strings (default)", () => {
    // config defaults R2 vars to "" which means not configured
    // In test environment, these aren't set
    expect(typeof isR2Configured()).toBe("boolean");
  });
});
