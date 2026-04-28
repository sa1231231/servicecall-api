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
}

export interface DataPoint {
  composite?: boolean;
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

export type RawDataPoint = string | BranchNode | Partial<DataPoint> & { variableName?: string; composite?: boolean; variables?: VariableDef[] };

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
