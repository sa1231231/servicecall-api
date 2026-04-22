import { describe, it, expect } from "vitest";
import {
  toLabel,
  LABEL_MAP,
  deriveNotificationConfig,
  type VariableEntry,
  type ClientInfo,
} from "../notification-config.js";

// ── toLabel ──────────────────────────────────────────────────────────────────

describe("toLabel", () => {
  it("returns LABEL_MAP value for known keys", () => {
    expect(toLabel("full_name")).toBe("Name");
    expect(toLabel("phone_number")).toBe("Phone");
    expect(toLabel("street_address")).toBe("Address");
    expect(toLabel("city")).toBe("City");
    expect(toLabel("email")).toBe("Email");
    expect(toLabel("company_name")).toBe("Company");
    expect(toLabel("problem_description")).toBe("Problem");
    expect(toLabel("preferred_time")).toBe("Preferred Time");
    expect(toLabel("preferred_day")).toBe("Preferred Day");
  });

  it("title-cases unknown variable names with underscores", () => {
    expect(toLabel("truck_number")).toBe("Truck Number");
    expect(toLabel("driver_phone_extension")).toBe("Driver Phone Extension");
    expect(toLabel("is_loaded")).toBe("Is Loaded");
  });

  it("title-cases single word variable names", () => {
    expect(toLabel("status")).toBe("Status");
  });

  it("prefers explicit dataPointLabel over LABEL_MAP", () => {
    expect(toLabel("full_name", "Customer Name")).toBe("Customer Name");
  });

  it("ignores dataPointLabel if it matches variableName", () => {
    expect(toLabel("full_name", "full_name")).toBe("Name");
  });

  it("ignores undefined dataPointLabel", () => {
    expect(toLabel("full_name", undefined)).toBe("Name");
  });
});

// ── deriveNotificationConfig ─────────────────────────────────────────────────

const baseClient: ClientInfo = {
  slug: "test-co",
  name: "Test Company",
  dispatch_text_numbers: ["+15551234567"],
};

describe("deriveNotificationConfig", () => {
  it("creates basic service_request config from simple variables", () => {
    const vars: VariableEntry[] = [
      { key: "full_name", label: "Name" },
      { key: "phone_number", label: "Phone" },
    ];

    const result = deriveNotificationConfig(vars, baseClient, "agent_123");

    expect(result.name).toBe("Test Company");
    expect(result.agent_ids).toEqual(["agent_123"]);
    expect(result.dispatch_text_numbers).toEqual(["+15551234567"]);
    expect(result.default_message_type).toBe("service_request");
    expect(result.resolve_rule).toBeUndefined();
    expect(result.message_types.service_request).toBeDefined();
    expect(result.message_types.emergency).toBeUndefined();
  });

  it("builds subject template from name, address, city", () => {
    const vars: VariableEntry[] = [
      { key: "full_name", label: "Name" },
      { key: "street_address", label: "Address" },
      { key: "city", label: "City" },
    ];

    const result = deriveNotificationConfig(vars, baseClient, "agent_123");
    expect(result.message_types.service_request.subject_template).toBe(
      "Service Request: {{full_name}} — {{street_address}}, {{city}}",
    );
  });

  it("builds subject template with only name", () => {
    const vars: VariableEntry[] = [{ key: "full_name", label: "Name" }];
    const result = deriveNotificationConfig(vars, baseClient, "agent_123");
    expect(result.message_types.service_request.subject_template).toBe(
      "Service Request: {{full_name}}",
    );
  });

  it("builds empty subject template when no name/address/city", () => {
    const vars: VariableEntry[] = [
      { key: "truck_number", label: "Truck Number" },
    ];
    const result = deriveNotificationConfig(vars, baseClient, "agent_123");
    expect(result.message_types.service_request.subject_template).toBe(
      "Service Request:",
    );
  });

  it("filters out phone_number_collected from fields", () => {
    const vars: VariableEntry[] = [
      { key: "full_name", label: "Name" },
      { key: "phone_number_collected", label: "Phone Collected" },
    ];

    const result = deriveNotificationConfig(vars, baseClient, "agent_123");
    const fieldKeys = result.message_types.service_request.fields.map(
      (f) => f.key,
    );
    expect(fieldKeys).toContain("full_name");
    expect(fieldKeys).not.toContain("phone_number_collected");
  });

  it("creates emergency + service_request when is_emergency present", () => {
    const vars: VariableEntry[] = [
      { key: "full_name", label: "Name" },
      { key: "phone_number", label: "Phone" },
      { key: "street_address", label: "Address" },
      { key: "city", label: "City" },
      { key: "problem_description", label: "Problem" },
      { key: "is_emergency", label: "Is Emergency" },
    ];

    const result = deriveNotificationConfig(vars, baseClient, "agent_123");

    expect(result.message_types.emergency).toBeDefined();
    expect(result.message_types.service_request).toBeDefined();
    expect(result.default_message_type).toBe("service_request");

    // Resolve rule
    expect(result.resolve_rule).toEqual({
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    });

    // Emergency has critical fields only
    const emergencyKeys = result.message_types.emergency.fields.map(
      (f) => f.key,
    );
    expect(emergencyKeys).toContain("full_name");
    expect(emergencyKeys).toContain("phone_number");
    expect(emergencyKeys).toContain("street_address");
    expect(emergencyKeys).not.toContain("is_emergency");

    // Emergency label and additional text
    expect(result.message_types.emergency.label).toBe("EMERGENCY CALL");
    expect(result.message_types.emergency.additional_text).toContain(
      "10 minutes",
    );
    expect(result.message_types.emergency.subject_template).toMatch(
      /^EMERGENCY:/,
    );

    // Service request has all fields
    const srKeys = result.message_types.service_request.fields.map(
      (f) => f.key,
    );
    expect(srKeys).toContain("full_name");
    expect(srKeys).toContain("is_emergency");
  });

  it("emergency fields fall back to all fields when no critical keys match", () => {
    const vars: VariableEntry[] = [
      { key: "truck_number", label: "Truck Number" },
      { key: "is_emergency", label: "Is Emergency" },
    ];

    const result = deriveNotificationConfig(vars, baseClient, "agent_123");
    // No critical keys match, so emergency gets all fields
    expect(result.message_types.emergency.fields.length).toBe(
      result.message_types.service_request.fields.length,
    );
  });

  it("creates mobile_emergency + service_request when is_service_request present", () => {
    const vars: VariableEntry[] = [
      { key: "company_name", label: "Company" },
      { key: "full_name", label: "Name" },
      { key: "phone_number", label: "Phone" },
      { key: "truck_number", label: "Truck Number" },
      { key: "breakdown_location", label: "Breakdown Location" },
      { key: "problem_description", label: "Problem" },
      { key: "vehicle_type", label: "Vehicle Type" },
      { key: "vehicle_manufacturer", label: "Vehicle Make" },
      { key: "whos_paying", label: "Who's Paying" },
      { key: "payment_method", label: "Payment Method" },
      { key: "is_service_request", label: "Is Service Request" },
    ];

    const result = deriveNotificationConfig(vars, baseClient, "agent_123");

    expect(result.message_types.mobile_emergency).toBeDefined();
    expect(result.message_types.service_request).toBeDefined();
    expect(result.default_message_type).toBe("mobile_emergency");

    // Resolve rule routes on is_service_request
    expect(result.resolve_rule).toEqual({
      field: "is_service_request",
      equals: "true",
      then: "service_request",
      else: "mobile_emergency",
    });

    // mobile_emergency gets all fields
    expect(result.message_types.mobile_emergency.fields.length).toBe(11);
    expect(result.message_types.mobile_emergency.label).toBe("EMERGENCY REPAIR CALL");

    // service_request gets fleet service fields (vehicle + payment info)
    const srKeys = result.message_types.service_request.fields.map((f) => f.key);
    expect(srKeys).toContain("full_name");
    expect(srKeys).toContain("phone_number");
    expect(srKeys).toContain("company_name");
    expect(srKeys).toContain("problem_description");
    expect(srKeys).toContain("vehicle_type");
    expect(srKeys).toContain("vehicle_manufacturer");
    expect(srKeys).toContain("whos_paying");
    expect(srKeys).toContain("payment_method");
    expect(srKeys).not.toContain("truck_number");
    expect(srKeys).not.toContain("breakdown_location");
  });

  it("is_emergency takes precedence over is_service_request", () => {
    const vars: VariableEntry[] = [
      { key: "full_name", label: "Name" },
      { key: "is_emergency", label: "Is Emergency" },
      { key: "is_service_request", label: "Is Service Request" },
    ];

    const result = deriveNotificationConfig(vars, baseClient, "agent_123");
    // is_emergency pattern wins
    expect(result.resolve_rule?.field).toBe("is_emergency");
    expect(result.message_types.emergency).toBeDefined();
    expect(result.message_types.mobile_emergency).toBeUndefined();
  });

  it("uses slug as name when no name provided", () => {
    const client: ClientInfo = {
      slug: "my-slug",
      dispatch_text_numbers: ["+15551234567"],
    };
    const result = deriveNotificationConfig([], client, "agent_123");
    expect(result.name).toBe("my-slug");
  });

  it("defaults optional client fields correctly", () => {
    const client: ClientInfo = {
      slug: "minimal",
      dispatch_text_numbers: ["+15551234567"],
    };
    const result = deriveNotificationConfig([], client, "agent_123");

    expect(result.dispatch_call_number).toBeNull();
    expect(result.summary_agent_id).toBeNull();
    expect(result.outbound_from_number).toBeNull();
    expect(result.dispatch_email).toBeNull();
    expect(result.dispatch_cc).toBeNull();
    expect(result.phone_fallback_to_caller).toBe(true);
    expect(result.hide_not_mentioned).toBe(false);
    expect(result.shadow_mode).toBe(true);
  });

  it("passes through provided client fields", () => {
    const client: ClientInfo = {
      slug: "full",
      name: "Full Client",
      dispatch_text_numbers: ["+15551234567"],
      dispatch_call_number: "+15559876543",
      dispatch_email: ["test@example.com"],
      dispatch_cc: "cc@example.com",
      outbound_from_number: "+15550001111",
      summary_agent_id: "agent_summary",
      phone_fallback_to_caller: false,
      hide_not_mentioned: true,
      shadow_mode: false,
    };
    const result = deriveNotificationConfig([], client, "agent_123");

    expect(result.dispatch_call_number).toBe("+15559876543");
    expect(result.dispatch_email).toEqual(["test@example.com"]);
    expect(result.dispatch_cc).toBe("cc@example.com");
    expect(result.outbound_from_number).toBe("+15550001111");
    expect(result.summary_agent_id).toBe("agent_summary");
    expect(result.phone_fallback_to_caller).toBe(false);
    expect(result.hide_not_mentioned).toBe(true);
    expect(result.shadow_mode).toBe(false);
  });

  it("handles empty variables array", () => {
    const result = deriveNotificationConfig([], baseClient, "agent_123");
    expect(result.message_types.service_request.fields).toEqual([]);
    expect(result.default_message_type).toBe("service_request");
  });
});
