import { describe, it, expect } from "vitest";
import crypto from "crypto";

// Replicate the session sign/verify logic from index.ts for unit testing
// (the actual functions are not exported, so we test the same algorithm)

const COOKIE_SECRET = "test-secret-key";

function signSession(payload: object): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64url");
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(b64).digest("base64url");
  return b64 + "." + sig;
}

function verifySession(cookie: string): object | null {
  const dot = cookie.indexOf(".");
  if (dot < 0) return null;
  const b64 = cookie.substring(0, dot);
  const sig = cookie.substring(dot + 1);
  const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(b64).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64url").toString());
  } catch {
    return null;
  }
}

describe("session sign/verify", () => {
  it("signs and verifies a valid session", () => {
    const user = { username: "sam", role: "admin", permissions: {}, isRoot: false };
    const cookie = signSession(user);
    const result = verifySession(cookie);
    expect(result).toEqual(user);
  });

  it("rejects a tampered payload", () => {
    const cookie = signSession({ username: "sam", role: "admin" });
    // Tamper with the payload part (before the dot)
    const [b64, sig] = cookie.split(".");
    const tampered = Buffer.from(JSON.stringify({ username: "hacker", role: "admin" })).toString("base64url");
    expect(verifySession(tampered + "." + sig)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const cookie = signSession({ username: "sam" });
    const [b64] = cookie.split(".");
    expect(verifySession(b64 + ".invalidsignature")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(verifySession("")).toBeNull();
  });

  it("rejects string without dot", () => {
    expect(verifySession("nodothere")).toBeNull();
  });

  it("rejects completely bogus cookie", () => {
    expect(verifySession("abc.def")).toBeNull();
  });

  it("produces different signatures for different payloads", () => {
    const c1 = signSession({ username: "alice" });
    const c2 = signSession({ username: "bob" });
    expect(c1).not.toBe(c2);
  });

  it("produces consistent signatures for same payload", () => {
    const payload = { username: "sam", role: "admin" };
    const c1 = signSession(payload);
    const c2 = signSession(payload);
    expect(c1).toBe(c2);
  });

  it("round-trips complex user object", () => {
    const user = {
      username: "operator1",
      role: "operator",
      permissions: {
        create_agents: true,
        edit_agents: true,
        clone_agents: false,
        delete_agents: false,
        send_comms: true,
        manage_settings: false,
        manage_data_points: false,
        manage_users: false,
      },
      isRoot: false,
    };
    const cookie = signSession(user);
    expect(verifySession(cookie)).toEqual(user);
  });

  it("round-trips root user", () => {
    const user = { username: "admin", role: "admin", permissions: {}, isRoot: true };
    const cookie = signSession(user);
    const result = verifySession(cookie);
    expect(result).toEqual(user);
    expect((result as any).isRoot).toBe(true);
  });
});
