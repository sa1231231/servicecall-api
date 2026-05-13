// ── Types ────────────────────────────────────────────────────────────────────

export interface FinetuneExample {
  type: "positive" | "negative";
  transcript: Array<{ content: string; role: "user" | "agent" }>;
  destination?: string;
  id?: string;
}

export interface ExtractEquation {
  left: string;
  operator: string;
  right?: string;
}

export interface VariableDef {
  variableName: string;
  type: "string" | "enum" | "boolean";
  choices?: string[];
  description: string;
  /** Display label used in outbound communications. Falls back to toLabel(variableName) when omitted. */
  label?: string;
}

export interface DataPoint {
  composite?: boolean;
  orphan?: boolean; // Extract-only: no Collect node, extracted passively from context
  label: string;
  variableName: string;
  type: "string" | "enum" | "boolean";
  choices?: string[];
  description: string;
  conversationPrompt: string;
  forwardCondition: string;
  finetuneExamples?: FinetuneExample[];
  extractSuccessEquation: ExtractEquation[];
  // Composite-only
  variables?: VariableDef[];
  // Set internally by resolveDataPoints when inside a branch (can be nested)
  _branchConditions?: BranchCondition[];
}

export interface BranchCondition {
  variable: string;
  operator: "==" | "!=";
  value: string;
}

export interface BranchNode {
  _branch: true;
  variable: string;
  operator: "==" | "!=";
  value: string;
  ifChain: RawDataPoint[];
  elseChain: RawDataPoint[];
}

// Deterministic mid-call action: fire an SMS via the send_sms CustomTool the
// generator registers on every flow. Appears inline in a path's dataPoints[]
// alongside data points; compiled to a Retell function node whose response
// flips a per-action sentinel variable so the Variables Router moves on.
//
// The `template` is a literal string; Retell does {{var}} substitution from
// collected_dynamic_variables before the tool call is made, so it can
// reference any previously-collected data point (e.g. {{phone_number}}).
//
// `to` defaults to the caller's number — the /retell/send-sms endpoint pulls
// call.from_number when args.to is omitted, including its "Web Call"/"unknown"
// guards. Pass an explicit "{{some_other_var}}" to override.
export interface SendSmsAction {
  _action: "sendSms";
  template: string;
  to?: string;
  name?: string;
}

export function isSendSmsAction(x: unknown): x is SendSmsAction {
  return typeof x === "object" && x !== null && (x as { _action?: unknown })._action === "sendSms";
}

export type RawDataPoint =
  | string
  | BranchNode
  | SendSmsAction
  | Partial<DataPoint> & { variableName?: string; composite?: boolean; variables?: VariableDef[] };

// ── Constants ────────────────────────────────────────────────────────────────

export const NOT_MENTIONED = "Not Mentioned";
export const CALLER_DOESNT_KNOW = "Caller Doesn't Know";
export const PHONE_COLLECTED_FLAG = "phone_number_collected";
export const PATH_TAKEN_VAR = "_path_taken";
export const INTERNAL_VARS = new Set([PHONE_COLLECTED_FLAG, PATH_TAKEN_VAR]);

// ── Helpers ─────────────────────────────────────────────────────────────────

export function defaultExtractEquation(varName: string): ExtractEquation[] {
  return [
    { left: `{{${varName}}}`, operator: "exists" },
    { left: `{{${varName}}}`, operator: "!=", right: NOT_MENTIONED },
  ];
}

// Data points are managed via the dashboard UI and stored in the
// `data_point_defaults` MongoDB collection. New deployments should clone
// MongoDB from production. See src/lib/data-point-defaults.ts for CRUD.
