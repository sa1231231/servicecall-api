import { describe, it, expect } from "vitest";
import { calculateCreditsCentsFromInvoice } from "../utils.js";

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
