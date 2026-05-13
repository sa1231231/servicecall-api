import { describe, it, expect, vi, beforeEach } from "vitest";

// The real Retell SDK's verify() is async. The mock returns a Promise to
// match — earlier versions returned literals, which let a regression slip
// through where the production code didn't await and treated every Promise
// as truthy.
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
  it("throws when signature is empty", async () => {
    await expect(verifyRetellWebhookOrThrow("body", "", "key")).rejects.toThrow(
      "Missing x-retell-signature header",
    );
  });

  it("throws when signatureKey is empty", async () => {
    await expect(verifyRetellWebhookOrThrow("body", "sig", "")).rejects.toThrow(
      "Missing RETELL_SIGNATURE_KEY",
    );
  });

  it("throws 'Invalid Retell signature' when SDK resolves false", async () => {
    mockVerify.mockResolvedValue(false);
    await expect(verifyRetellWebhookOrThrow("body", "sig", "key")).rejects.toThrow(
      "Invalid Retell signature",
    );
    expect(mockVerify).toHaveBeenCalledWith("body", "key", "sig");
  });

  it("does not throw when SDK resolves true", async () => {
    mockVerify.mockResolvedValue(true);
    await expect(verifyRetellWebhookOrThrow("body", "sig", "key")).resolves.toBeUndefined();
  });

  it("guards before calling SDK (no SDK call when signature missing)", async () => {
    await expect(verifyRetellWebhookOrThrow("body", "", "key")).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  // Regression: if the production code stops awaiting Retell.verify(), the
  // returned Promise is truthy and forged signatures slip through. This
  // test pins the await by making the SDK resolve to false — only an
  // awaited result lets the !ok branch throw.
  it("regression: awaits the SDK (Promise<false> still rejects)", async () => {
    mockVerify.mockReturnValue(Promise.resolve(false));
    await expect(verifyRetellWebhookOrThrow("body", "sig", "key")).rejects.toThrow(
      "Invalid Retell signature",
    );
  });
});

describe("verifyRetellWebhookOr401", () => {
  it("returns true and does not write response on valid signature", async () => {
    mockVerify.mockResolvedValue(true);
    const res = makeRes();
    await expect(verifyRetellWebhookOr401("body", "sig", "key", res)).resolves.toBe(true);
    expect(res._json).toBeNull();
  });

  it("returns false and writes 401 with missing_signature_header outcome", async () => {
    const res = makeRes();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(verifyRetellWebhookOr401("body", "", "key", res)).resolves.toBe(false);
    expect(res._status).toBe(401);
    expect(res._json.outcome).toBe("missing_signature_header");
    expect(res._json.ok).toBe(false);
    err.mockRestore();
  });

  it("returns false with missing_signature_key outcome when key is empty", async () => {
    const res = makeRes();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(verifyRetellWebhookOr401("body", "sig", "", res)).resolves.toBe(false);
    expect(res._status).toBe(401);
    expect(res._json.outcome).toBe("missing_signature_key");
    err.mockRestore();
  });

  it("returns false with invalid_signature outcome when SDK rejects", async () => {
    mockVerify.mockResolvedValue(false);
    const res = makeRes();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(verifyRetellWebhookOr401("body", "bad-sig", "key", res)).resolves.toBe(false);
    expect(res._status).toBe(401);
    expect(res._json.outcome).toBe("invalid_signature");
    err.mockRestore();
  });
});
