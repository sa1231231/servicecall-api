import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));

vi.mock("retell-sdk", () => ({
  default: { verify: (...a: any[]) => mockVerify(...a) },
}));

const { verifyRetellWebhookOrThrow, verifyRetellWebhookOr401 } = await import("../verify-retell.js");

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRes() {
  const res: any = { _status: 200, _json: null };
  res.status = (code: number) => { res._status = code; return res; };
  res.json = (data: any) => { res._json = data; return res; };
  return res;
}

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

  it("throws 'Invalid Retell signature' when SDK returns false", () => {
    mockVerify.mockReturnValue(false);
    expect(() => verifyRetellWebhookOrThrow("body", "sig", "key")).toThrow(
      "Invalid Retell signature",
    );
    expect(mockVerify).toHaveBeenCalledWith("body", "key", "sig");
  });

  it("does not throw when SDK returns true", () => {
    mockVerify.mockReturnValue(true);
    expect(() => verifyRetellWebhookOrThrow("body", "sig", "key")).not.toThrow();
  });

  it("guards before calling SDK (no SDK call when signature missing)", () => {
    expect(() => verifyRetellWebhookOrThrow("body", "", "key")).toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe("verifyRetellWebhookOr401", () => {
  it("returns true and does not write response on valid signature", () => {
    mockVerify.mockReturnValue(true);
    const res = makeRes();
    expect(verifyRetellWebhookOr401("body", "sig", "key", res)).toBe(true);
    expect(res._json).toBeNull();
  });

  it("returns false and writes 401 with missing_signature_header outcome", () => {
    const res = makeRes();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(verifyRetellWebhookOr401("body", "", "key", res)).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json.outcome).toBe("missing_signature_header");
    expect(res._json.ok).toBe(false);
    err.mockRestore();
  });

  it("returns false with missing_signature_key outcome when key is empty", () => {
    const res = makeRes();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(verifyRetellWebhookOr401("body", "sig", "", res)).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json.outcome).toBe("missing_signature_key");
    err.mockRestore();
  });

  it("returns false with invalid_signature outcome when SDK rejects", () => {
    mockVerify.mockReturnValue(false);
    const res = makeRes();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(verifyRetellWebhookOr401("body", "bad-sig", "key", res)).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json.outcome).toBe("invalid_signature");
    err.mockRestore();
  });
});
