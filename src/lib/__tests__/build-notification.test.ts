import { describe, it, expect } from "vitest";
import { buildNotificationMessages, renderTemplate } from "../build-notification.js";
import type { ClientNotificationConfig } from "../../config/notification-clients.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ClientNotificationConfig> = {}): ClientNotificationConfig {
  return {
    name: "Test Plumbing",
    agent_id: "agent_test",
    dispatch_text_numbers: ["+15551234567"],
    dispatch_call_number: null,
    summary_agent_id: null,
    outbound_from_number: null,
    dispatch_email: ["dispatch@test.com"],
    dispatch_cc: null,
    resolve_type: () => "service_request",
    message_types: {
      service_request: {
        label: "New Service Request",
        subject_template: "Service Request: {{full_name}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "problem_description", label: "Problem" },
        ],
      },
    },
    default_message_type: "service_request",
    ...overrides,
  };
}

const STANDARD_VARS: Record<string, string> = {
  full_name: "John Doe",
  phone_number: "555-123-4567",
  problem_description: "Leaking faucet in kitchen",
};

// ── Happy path ───────────────────────────────────────────────────────────────

describe("buildNotificationMessages", () => {
  it("builds SMS and email for a standard service request", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig(),
      allVars: STANDARD_VARS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.typeKey).toBe("service_request");
    expect(result.payload.smsMessage).toContain("Hi Test Plumbing, you have a new call!");
    expect(result.payload.smsMessage).toContain("Name: John Doe");
    expect(result.payload.smsMessage).toContain("Phone: 555-123-4567");
    expect(result.payload.smsMessage).toContain("Problem: Leaking faucet in kitchen");
    expect(result.payload.smsMessage).toContain("— Service Call Saver");
    expect(result.payload.emailSubject).toBe("Service Request: John Doe");
    expect(result.payload.emailHtml).toContain("<strong>Name:</strong> John Doe");
    expect(result.payload.emailBody).toContain("servicecallsaver.com");
  });

  // ── no_message_type ──────────────────────────────────────────────────

  it("returns no_message_type when no types configured", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        resolve_type: () => "nonexistent",
        message_types: {},
      }),
      allVars: STANDARD_VARS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_message_type");
  });

  // ── failed_required ──────────────────────────────────────────────────

  it("returns failed_required when a required field is missing", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Service Request",
            subject_template: "{{full_name}}",
            fields: [
              { key: "full_name", label: "Name", required: true },
              { key: "phone_number", label: "Phone" },
            ],
          },
        },
      }),
      allVars: { full_name: "", phone_number: "555-0000" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("failed_required");
    expect(result.details).toContain("full_name");
  });

  it("returns failed_required when required field is 'Not Mentioned'", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Service Request",
            subject_template: "{{full_name}}",
            fields: [
              { key: "full_name", label: "Name", required: true },
              { key: "problem_description", label: "Problem" },
            ],
          },
        },
      }),
      allVars: { full_name: "Not Mentioned", problem_description: "test" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("failed_required");
  });

  it("returns failed_required when conditional required does not match", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Service Request",
            subject_template: "{{full_name}}",
            fields: [
              { key: "full_name", label: "Name" },
              { key: "status", label: "Status", required: { equals: "active" } },
            ],
          },
        },
      }),
      allVars: { full_name: "John", status: "inactive" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("failed_required");
  });

  // ── empty_call ───────────────────────────────────────────────────────

  it("returns empty_call when no meaningful data collected", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig(),
      allVars: { full_name: "", phone_number: "555-0000", problem_description: "" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty_call");
  });

  // ── phone_fallback_to_caller ─────────────────────────────────────────

  it("uses callerNumber when phone_fallback_to_caller is enabled and phone is empty", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({ phone_fallback_to_caller: true }),
      allVars: { full_name: "Jane", phone_number: "", problem_description: "broken pipe" },
      callerNumber: "+15559999999",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.fieldValues.phone_number).toBe("+15559999999");
  });

  it("uses callerNumber when phone is 'Not Mentioned'", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({ phone_fallback_to_caller: true }),
      allVars: { full_name: "Jane", phone_number: "Not Mentioned", problem_description: "broken pipe" },
      callerNumber: "+15559999999",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.fieldValues.phone_number).toBe("+15559999999");
  });

  // ── show / show_when / format ────────────────────────────────────────

  it("hides fields with show: false", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Service Request",
            subject_template: "{{full_name}}",
            fields: [
              { key: "full_name", label: "Name" },
              { key: "internal_note", label: "Note", show: false },
              { key: "problem_description", label: "Problem" },
            ],
          },
        },
      }),
      allVars: { full_name: "John", internal_note: "secret", problem_description: "leak" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.visibleFields.map((f) => f.label)).not.toContain("Note");
    expect(result.payload.smsMessage).not.toContain("secret");
  });

  it("respects show_when conditional visibility", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Service Request",
            subject_template: "{{full_name}}",
            fields: [
              { key: "full_name", label: "Name" },
              { key: "is_emergency", label: "Emergency" },
              { key: "eta", label: "ETA", show_when: { field: "is_emergency", equals: "true" } },
              { key: "problem_description", label: "Problem" },
            ],
          },
        },
      }),
      allVars: { full_name: "John", is_emergency: "false", eta: "30 min", problem_description: "leak" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.visibleFields.map((f) => f.label)).not.toContain("ETA");
  });

  it("shows field when show_when condition is met", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Service Request",
            subject_template: "{{full_name}}",
            fields: [
              { key: "full_name", label: "Name" },
              { key: "is_emergency", label: "Emergency" },
              { key: "eta", label: "ETA", show_when: { field: "is_emergency", equals: "true" } },
              { key: "problem_description", label: "Problem" },
            ],
          },
        },
      }),
      allVars: { full_name: "John", is_emergency: "true", eta: "30 min", problem_description: "leak" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.visibleFields.map((f) => f.label)).toContain("ETA");
  });

  it("formats yes_no fields", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Service Request",
            subject_template: "{{full_name}}",
            fields: [
              { key: "full_name", label: "Name" },
              { key: "is_emergency", label: "Emergency", format: "yes_no" },
              { key: "problem_description", label: "Problem" },
            ],
          },
        },
      }),
      allVars: { full_name: "John", is_emergency: "true", problem_description: "leak" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const emergencyField = result.payload.visibleFields.find((f) => f.label === "Emergency");
    expect(emergencyField?.value).toBe("Yes");
  });

  // ── hide_not_mentioned ───────────────────────────────────────────────

  it("hides 'Not Mentioned' values when hide_not_mentioned is enabled", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({ hide_not_mentioned: true }),
      allVars: { full_name: "John", phone_number: "Not Mentioned", problem_description: "leak" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.visibleFields.map((f) => f.label)).not.toContain("Phone");
  });

  // ── additional_text ──────────────────────────────────────────────────

  it("includes additional_text in messages", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig({
        message_types: {
          service_request: {
            label: "Emergency",
            subject_template: "{{full_name}}",
            additional_text: "Caller expects contact within 10 minutes",
            fields: [
              { key: "full_name", label: "Name" },
              { key: "problem_description", label: "Problem" },
            ],
          },
        },
      }),
      allVars: { full_name: "John", problem_description: "gas leak" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.smsMessage).toContain("Caller expects contact within 10 minutes");
    expect(result.payload.emailHtml).toContain("Caller expects contact within 10 minutes");
  });

  // ── HTML escaping ────────────────────────────────────────────────────

  it("escapes HTML in email content", () => {
    const result = buildNotificationMessages({
      clientConfig: makeConfig(),
      allVars: { full_name: '<script>alert("xss")</script>', phone_number: "555-0000", problem_description: "test" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.emailHtml).not.toContain("<script>");
    expect(result.payload.emailHtml).toContain("&lt;script&gt;");
  });
});

// ── renderTemplate ───────────────────────────────────────────────────────────

describe("renderTemplate", () => {
  it("replaces placeholders with values", () => {
    expect(renderTemplate("Hello {{name}}, your order {{id}}", { name: "John", id: "123" }))
      .toBe("Hello John, your order 123");
  });

  it("replaces missing keys with empty string", () => {
    expect(renderTemplate("Hello {{name}}", {})).toBe("Hello ");
  });
});
