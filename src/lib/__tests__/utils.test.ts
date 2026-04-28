import { describe, it, expect } from "vitest";
import {
  msToIso,
  roundUpToTenthCent,
  roundTo1Decimal,
  calculateCreditsCentsFromInvoice,
} from "../utils.js";

describe("msToIso", () => {
  it("converts valid ms timestamp to ISO string", () => {
    const result = msToIso(1700000000000);
    expect(result).toBe(new Date(1700000000000).toISOString());
  });

  it("returns null for null", () => {
    expect(msToIso(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(msToIso(undefined)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(msToIso(NaN)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(msToIso(Infinity)).toBeNull();
  });

  it("handles zero (epoch)", () => {
    expect(msToIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});

describe("roundUpToTenthCent", () => {
  it("rounds up to nearest tenth of a cent", () => {
    expect(roundUpToTenthCent(1.01)).toBe(1.1);
    expect(roundUpToTenthCent(1.11)).toBe(1.2);
  });

  it("keeps exact tenths unchanged", () => {
    expect(roundUpToTenthCent(1.0)).toBe(1.0);
    expect(roundUpToTenthCent(1.5)).toBe(1.5);
  });

  it("handles zero", () => {
    expect(roundUpToTenthCent(0)).toBe(0);
  });

  it("rounds up small fractional values", () => {
    expect(roundUpToTenthCent(0.01)).toBe(0.1);
    expect(roundUpToTenthCent(0.09)).toBe(0.1);
  });
});

describe("roundTo1Decimal", () => {
  it("rounds to 1 decimal place", () => {
    expect(roundTo1Decimal(1.25)).toBe(1.3);
    expect(roundTo1Decimal(1.24)).toBe(1.2);
  });

  it("handles whole numbers", () => {
    expect(roundTo1Decimal(5)).toBe(5.0);
  });

  it("handles zero", () => {
    expect(roundTo1Decimal(0)).toBe(0);
  });
});

describe("calculateCreditsCentsFromInvoice", () => {
  it("returns amount_paid as integer from number", () => {
    expect(calculateCreditsCentsFromInvoice({ amount_paid: 4970 })).toBe(4970);
  });

  it("truncates fractional cents", () => {
    expect(calculateCreditsCentsFromInvoice({ amount_paid: 4970.99 })).toBe(4970);
  });

  it("parses amount_paid from string", () => {
    expect(calculateCreditsCentsFromInvoice({ amount_paid: "4970" })).toBe(4970);
  });

  it("returns 0 for non-numeric string", () => {
    expect(calculateCreditsCentsFromInvoice({ amount_paid: "invalid" })).toBe(0);
  });

  it("returns 0 for null invoice", () => {
    expect(calculateCreditsCentsFromInvoice(null)).toBe(0);
  });

  it("returns 0 for undefined invoice", () => {
    expect(calculateCreditsCentsFromInvoice(undefined)).toBe(0);
  });

  it("returns 0 for missing amount_paid", () => {
    expect(calculateCreditsCentsFromInvoice({})).toBe(0);
  });

  it("returns 0 for NaN amount_paid", () => {
    expect(calculateCreditsCentsFromInvoice({ amount_paid: NaN })).toBe(0);
  });

  it("returns 0 for Infinity amount_paid", () => {
    expect(calculateCreditsCentsFromInvoice({ amount_paid: Infinity })).toBe(0);
  });
});
