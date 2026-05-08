import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: "tok-test",
  },
}));

const { lookupCallerName, formatCallerName } = await import("../twilio-caller-name.js");

describe("lookupCallerName", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn() as any;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("normalizes a 10-digit phone to E.164 and parses Twilio's caller_name response", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        caller_name: { caller_name: "MR FIX IT", caller_type: "CONSUMER", error_code: null },
        national_format: "(765) 480-3157",
      }),
    });
    const out = await lookupCallerName("7654803157");
    expect(out.ok).toBe(true);
    expect(out.phone).toBe("+17654803157");
    expect(out.lookup?.callerName).toBe("MR FIX IT");
    expect(out.lookup?.callerType).toBe("CONSUMER");
    expect(out.lookup?.nationalFormat).toBe("(765) 480-3157");

    const args = (global.fetch as any).mock.calls[0];
    expect(args[0]).toContain("lookups.twilio.com/v2/PhoneNumbers/%2B17654803157");
    expect(args[0]).toContain("Fields=caller_name");
    expect(args[1].headers.Authorization).toMatch(/^Basic /);
  });

  it("strips the Meta `p:+1...` prefix correctly", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ caller_name: { caller_name: "X", caller_type: "BUSINESS", error_code: null } }),
    });
    const out = await lookupCallerName("p:+17654803157");
    expect(out.ok).toBe(true);
    expect(out.phone).toBe("+17654803157");
  });

  it("returns ok=false for non-US-format phones (Twilio caller-name is NANP only)", async () => {
    const out = await lookupCallerName("+44 20 7946 0958");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/NANP|US/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns ok=false on Twilio HTTP error without throwing", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "auth failed",
    });
    const out = await lookupCallerName("7654803157");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("401");
  });

  it("returns ok=false on network error without throwing", async () => {
    (global.fetch as any).mockRejectedValue(new Error("ECONNRESET"));
    const out = await lookupCallerName("7654803157");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("ECONNRESET");
  });
});

describe("formatCallerName", () => {
  it("returns empty string for undefined input (block omitted entirely)", () => {
    expect(formatCallerName(undefined)).toBe("");
  });

  it("renders an error block when the lookup failed", () => {
    const out = formatCallerName({ ok: false, phone: "+17654803157", error: "Twilio 401" });
    expect(out).toContain("## Twilio caller-name");
    expect(out).toContain("Twilio 401");
  });

  it("renders a 'no entry' line when CNAM had no name", () => {
    const out = formatCallerName({
      ok: true,
      phone: "+17654803157",
      lookup: { callerName: undefined, callerType: undefined },
    });
    expect(out).toContain("(no CNAM entry for +17654803157)");
  });

  it("renders the resolved name + type + phone when present", () => {
    const out = formatCallerName({
      ok: true,
      phone: "+17654803157",
      lookup: { callerName: "MR FIX IT", callerType: "CONSUMER", nationalFormat: "(765) 480-3157" },
    });
    expect(out).toContain("**Name:** MR FIX IT");
    expect(out).toContain("**Type:** CONSUMER");
    expect(out).toContain("**Phone:** (765) 480-3157");
  });
});
