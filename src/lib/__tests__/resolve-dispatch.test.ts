import { describe, it, expect } from "vitest";
import { resolveDispatch } from "../resolve-dispatch.js";
import type { ClientNotificationConfig } from "../../config/notification-clients.js";

function makeConfig(overrides: Partial<ClientNotificationConfig> = {}): ClientNotificationConfig {
  return {
    name: "Test Co",
    agent_id: "agent_1",
    dispatch_text_numbers: ["+15551111111"],
    dispatch_call_number: "+15552222222",
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: ["default@test.com"],
    dispatch_cc: "cc@test.com",
    resolve_type: () => "service_request",
    message_types: {},
    default_message_type: "service_request",
    ...overrides,
  };
}

describe("resolveDispatch", () => {
  it("returns client-level defaults when no dispatch_by_type", () => {
    const config = makeConfig();
    const result = resolveDispatch(config, "service_request");

    expect(result.text_numbers).toEqual(["+15551111111"]);
    expect(result.email).toEqual(["default@test.com"]);
    expect(result.cc).toBe("cc@test.com");
    expect(result.call_number).toBe("+15552222222");
  });

  it("returns client-level defaults when typeKey has no override", () => {
    const config = makeConfig({
      dispatch_by_type: {
        emergency: { dispatch_text_numbers: ["+15559999999"] },
      },
    });
    const result = resolveDispatch(config, "service_request");

    expect(result.text_numbers).toEqual(["+15551111111"]);
    expect(result.email).toEqual(["default@test.com"]);
    expect(result.cc).toBe("cc@test.com");
    expect(result.call_number).toBe("+15552222222");
  });

  it("uses per-type override for SMS numbers", () => {
    const config = makeConfig({
      dispatch_by_type: {
        automotive: { dispatch_text_numbers: ["+15553333333", "+15554444444"] },
      },
    });
    const result = resolveDispatch(config, "automotive");

    expect(result.text_numbers).toEqual(["+15553333333", "+15554444444"]);
    // Other fields fall back to defaults
    expect(result.email).toEqual(["default@test.com"]);
    expect(result.cc).toBe("cc@test.com");
    expect(result.call_number).toBe("+15552222222");
  });

  it("uses per-type override for email", () => {
    const config = makeConfig({
      dispatch_by_type: {
        window_tinting: { dispatch_email: ["tint@shop.com"] },
      },
    });
    const result = resolveDispatch(config, "window_tinting");

    expect(result.email).toEqual(["tint@shop.com"]);
    expect(result.text_numbers).toEqual(["+15551111111"]);
  });

  it("uses per-type override for cc", () => {
    const config = makeConfig({
      dispatch_by_type: {
        residential: { dispatch_cc: "manager@shop.com" },
      },
    });
    const result = resolveDispatch(config, "residential");

    expect(result.cc).toBe("manager@shop.com");
  });

  it("allows per-type cc to be null (override to no cc)", () => {
    const config = makeConfig({
      dispatch_cc: "default-cc@test.com",
      dispatch_by_type: {
        automotive: { dispatch_cc: null },
      },
    });
    const result = resolveDispatch(config, "automotive");

    expect(result.cc).toBeNull();
  });

  it("uses per-type override for call number", () => {
    const config = makeConfig({
      dispatch_by_type: {
        commercial: { dispatch_call_number: "+15558888888" },
      },
    });
    const result = resolveDispatch(config, "commercial");

    expect(result.call_number).toBe("+15558888888");
  });

  it("allows per-type call number to be null (disable voice dispatch)", () => {
    const config = makeConfig({
      dispatch_call_number: "+15552222222",
      dispatch_by_type: {
        automotive: { dispatch_call_number: null },
      },
    });
    const result = resolveDispatch(config, "automotive");

    expect(result.call_number).toBeNull();
  });

  it("overrides all fields at once for a type", () => {
    const config = makeConfig({
      dispatch_by_type: {
        vip: {
          dispatch_text_numbers: ["+15550001111"],
          dispatch_email: ["vip@shop.com"],
          dispatch_cc: "boss@shop.com",
          dispatch_call_number: "+15550002222",
        },
      },
    });
    const result = resolveDispatch(config, "vip");

    expect(result.text_numbers).toEqual(["+15550001111"]);
    expect(result.email).toEqual(["vip@shop.com"]);
    expect(result.cc).toBe("boss@shop.com");
    expect(result.call_number).toBe("+15550002222");
  });

  it("handles multiple type keys independently", () => {
    const config = makeConfig({
      dispatch_by_type: {
        automotive: { dispatch_text_numbers: ["+1auto"] },
        residential: { dispatch_text_numbers: ["+1res"] },
      },
    });

    expect(resolveDispatch(config, "automotive").text_numbers).toEqual(["+1auto"]);
    expect(resolveDispatch(config, "residential").text_numbers).toEqual(["+1res"]);
    expect(resolveDispatch(config, "other").text_numbers).toEqual(["+15551111111"]);
  });

  it("works when client-level email is null and no override", () => {
    const config = makeConfig({ dispatch_email: null });
    const result = resolveDispatch(config, "service_request");

    expect(result.email).toBeNull();
  });
});
