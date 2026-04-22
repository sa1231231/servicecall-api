import type {
  JsonClientEntry,
  ResolveRule,
} from "../config/client-store.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VariableEntry {
  key: string;
  label: string;
}

export interface ClientInfo {
  slug: string;
  name?: string;
  dispatch_text_numbers: string[];
  dispatch_call_number?: string | null;
  dispatch_email?: string[] | null;
  dispatch_cc?: string | null;
  outbound_from_number?: string | null;
  summary_agent_id?: string | null;
  phone_fallback_to_caller?: boolean;
  hide_not_mentioned?: boolean;
  shadow_mode?: boolean;
}

// ── Label Mapping ────────────────────────────────────────────────────────────

export const LABEL_MAP: Record<string, string> = {
  full_name: "Name",
  phone_number: "Phone",
  street_address: "Address",
  city: "City",
  email: "Email",
  company_name: "Company",
  problem_description: "Problem",
  preferred_time: "Preferred Time",
  preferred_day: "Preferred Day",
};

export function toLabel(variableName: string, dataPointLabel?: string): string {
  if (dataPointLabel && dataPointLabel !== variableName) return dataPointLabel;
  if (LABEL_MAP[variableName]) return LABEL_MAP[variableName];
  return variableName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Derive Notification Config ───────────────────────────────────────────────

export function deriveNotificationConfig(
  variables: VariableEntry[],
  clientInfo: ClientInfo,
  agentId: string,
): JsonClientEntry {
  // Filter out internal variables
  const fields = variables
    .filter((v) => v.key !== "phone_number_collected")
    .map((v) => ({ key: v.key, label: v.label }));

  // Check if is_emergency is among the variables
  const hasEmergency = variables.some((v) => v.key === "is_emergency");

  // Build subject template from available fields
  const hasName = fields.some((f) => f.key === "full_name");
  const hasAddress = fields.some((f) => f.key === "street_address");
  const hasCity = fields.some((f) => f.key === "city");

  let subjectParts = "";
  if (hasName) subjectParts += "{{full_name}}";
  if (hasAddress) subjectParts += ` — {{street_address}}`;
  if (hasCity) subjectParts += `, {{city}}`;

  // Build message types
  const messageTypes: JsonClientEntry["message_types"] = {};
  let resolveRule: ResolveRule | undefined;
  let defaultMessageType: string;

  if (hasEmergency) {
    // Critical fields for emergency: name, phone, address, city, problem
    const criticalKeys = new Set([
      "full_name",
      "phone_number",
      "street_address",
      "city",
      "problem_description",
    ]);
    const emergencyFields = fields.filter((f) => criticalKeys.has(f.key));

    messageTypes.emergency = {
      label: "EMERGENCY CALL",
      subject_template: `EMERGENCY: ${subjectParts}`.trim(),
      additional_text: "Caller expects contact within 10 minutes.",
      fields: emergencyFields.length > 0 ? emergencyFields : fields,
    };
    messageTypes.service_request = {
      label: "New Service Request",
      subject_template: `Service Request: ${subjectParts}`.trim(),
      fields,
    };
    resolveRule = {
      field: "is_emergency",
      equals: "true",
      then: "emergency",
      else: "service_request",
    };
    defaultMessageType = "service_request";
  } else {
    messageTypes.service_request = {
      label: "New Service Request",
      subject_template: `Service Request: ${subjectParts}`.trim(),
      fields,
    };
    defaultMessageType = "service_request";
  }

  return {
    name: clientInfo.name ?? clientInfo.slug,
    agent_ids: [agentId],
    dispatch_text_numbers: clientInfo.dispatch_text_numbers,
    dispatch_call_number: clientInfo.dispatch_call_number ?? null,
    summary_agent_id: clientInfo.summary_agent_id ?? null,
    outbound_from_number: clientInfo.outbound_from_number ?? null,
    dispatch_email: clientInfo.dispatch_email ?? null,
    dispatch_cc: clientInfo.dispatch_cc ?? null,
    resolve_rule: resolveRule,
    message_types: messageTypes,
    default_message_type: defaultMessageType,
    phone_fallback_to_caller: clientInfo.phone_fallback_to_caller ?? true,
    hide_not_mentioned: clientInfo.hide_not_mentioned ?? false,
    shadow_mode: clientInfo.shadow_mode ?? true,
  };
}
