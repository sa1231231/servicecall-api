import type {
  JsonClientEntry,
  ResolveRule,
  ResolveRuleEntry,
} from "../config/client-store.js";
import { INTERNAL_VARS, PATH_TAKEN_VAR } from "./agent-generator/data-point-registry.js";

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

export interface PathVariables {
  name: string;
  variables: VariableEntry[];
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
  // Trucking
  truck_number: "Truck #",
  driver_name: "Driver",
  driver_phone: "Driver Phone",
  breakdown_location: "Location",
  vehicle_type: "Vehicle Type",
  vehicle_manufacturer: "Make",
  vehicle_color: "Color",
  whos_paying: "Who's Paying",
  payment_method: "Payment Method",
};

export function toLabel(variableName: string, dataPointLabel?: string): string {
  if (dataPointLabel && dataPointLabel !== variableName) return dataPointLabel;
  if (LABEL_MAP[variableName]) return LABEL_MAP[variableName];
  return variableName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildSubjectTemplate(
  fields: Array<{ key: string; label: string }>,
): string {
  const hasName = fields.some((f) => f.key === "full_name");
  const hasAddress = fields.some((f) => f.key === "street_address");
  const hasCity = fields.some((f) => f.key === "city");

  let parts = "";
  if (hasName) parts += "{{full_name}}";
  if (hasAddress) parts += ` — {{street_address}}`;
  if (hasCity) parts += `, {{city}}`;
  return parts;
}

function filterInternalVars(
  variables: VariableEntry[],
): Array<{ key: string; label: string }> {
  return variables
    .filter((v) => !INTERNAL_VARS.has(v.key))
    .map((v) => ({ key: v.key, label: v.label }));
}

function buildClientEntry(
  clientInfo: ClientInfo,
  agentId: string,
  messageTypes: JsonClientEntry["message_types"],
  defaultMessageType: string,
  resolveRule?: ResolveRule,
  resolveRules?: ResolveRuleEntry[],
): JsonClientEntry {
  return {
    name: clientInfo.name ?? clientInfo.slug,
    agent_id: agentId,
    dispatch_text_numbers: clientInfo.dispatch_text_numbers,
    dispatch_call_number: clientInfo.dispatch_call_number ?? null,
    summary_agent_id: clientInfo.summary_agent_id ?? null,
    outbound_from_number: clientInfo.outbound_from_number ?? null,
    dispatch_email: clientInfo.dispatch_email ?? null,
    dispatch_cc: clientInfo.dispatch_cc ?? null,
    resolve_rule: resolveRule,
    resolve_rules: resolveRules,
    message_types: messageTypes,
    default_message_type: defaultMessageType,
    phone_fallback_to_caller: clientInfo.phone_fallback_to_caller ?? true,
    hide_not_mentioned: clientInfo.hide_not_mentioned ?? false,
    shadow_mode: clientInfo.shadow_mode ?? true,
  };
}

// ── Derive Notification Config (single-path) ────────────────────────────────

export function deriveNotificationConfig(
  variables: VariableEntry[],
  clientInfo: ClientInfo,
  agentId: string,
): JsonClientEntry {
  // Filter out internal variables
  const fields = filterInternalVars(variables);

  // Check for routing variables
  const hasEmergency = variables.some((v) => v.key === "is_emergency");
  const hasServiceRequest = variables.some((v) => v.key === "is_service_request");

  const subjectParts = buildSubjectTemplate(fields);

  // Build message types
  const messageTypes: JsonClientEntry["message_types"] = {};
  let resolveRule: ResolveRule | undefined;
  let defaultMessageType: string;

  // Critical fields for emergency-type messages (residential/commercial)
  const criticalKeys = new Set([
    "full_name",
    "phone_number",
    "street_address",
    "city",
    "problem_description",
  ]);

  // Service request fields for fleet/mobile repair agents —
  // non-emergency scheduled work still needs vehicle + payment info
  const fleetServiceKeys = new Set([
    "full_name",
    "phone_number",
    "company_name",
    "vehicle_type",
    "vehicle_manufacturer",
    "problem_description",
    "whos_paying",
    "payment_method",
  ]);

  if (hasEmergency) {
    // Pattern: is_emergency = true → emergency, else → service_request
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
  } else if (hasServiceRequest) {
    // Pattern: is_service_request = true → service_request, else → mobile_emergency
    // (used by fleet/mobile repair agents like J&A Fleet)
    const serviceFields = fields.filter((f) => fleetServiceKeys.has(f.key));

    messageTypes.mobile_emergency = {
      label: "EMERGENCY REPAIR CALL",
      subject_template: `EMERGENCY: ${subjectParts}`.trim(),
      fields,
    };
    messageTypes.service_request = {
      label: "SERVICE REQUEST",
      subject_template: `Service Request: ${subjectParts}`.trim(),
      fields: serviceFields.length > 0 ? serviceFields : fields,
    };
    resolveRule = {
      field: "is_service_request",
      equals: "true",
      then: "service_request",
      else: "mobile_emergency",
    };
    defaultMessageType = "mobile_emergency";
  } else {
    messageTypes.service_request = {
      label: "New Service Request",
      subject_template: `Service Request: ${subjectParts}`.trim(),
      fields,
    };
    defaultMessageType = "service_request";
  }

  return buildClientEntry(
    clientInfo,
    agentId,
    messageTypes,
    defaultMessageType,
    resolveRule,
  );
}

// ── Derive Notification Config (multi-path) ─────────────────────────────────

function pathNameToKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

export function deriveMultiPathNotificationConfig(
  pathVariables: PathVariables[],
  clientInfo: ClientInfo,
  agentId: string,
): JsonClientEntry {
  const messageTypes: JsonClientEntry["message_types"] = {};
  const resolveRules: ResolveRuleEntry[] = [];

  for (const path of pathVariables) {
    const fields = filterInternalVars(path.variables);
    const typeKey = pathNameToKey(path.name);
    const subjectParts = buildSubjectTemplate(fields);

    messageTypes[typeKey] = {
      label: path.name,
      subject_template: `${path.name}: ${subjectParts}`.trim(),
      fields,
    };

    resolveRules.push({
      field: PATH_TAKEN_VAR,
      equals: path.name,
      then: typeKey,
    });
  }

  const defaultMessageType = Object.keys(messageTypes)[0];

  return buildClientEntry(
    clientInfo,
    agentId,
    messageTypes,
    defaultMessageType,
    undefined,
    resolveRules,
  );
}
