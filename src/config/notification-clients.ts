export const ownerConfig = {
  phone: "+13017872841",
  email: "samasra93@gmail.com",
};

export function setOwnerConfig(email: string, phone: string): void {
  ownerConfig.email = email;
  ownerConfig.phone = phone;
}

export interface Field {
  key: string;
  label: string;
  show?: boolean;
  required?: true | { equals: string | string[] };
  show_when?: { field: string; equals: string | string[] };
  format?: "yes_no";
}

export interface MessageType {
  label: string;
  subject_template: string;
  additional_text?: string;
  fields: Field[];
}

export interface ClientNotificationConfig {
  name: string;
  agent_id: string;
  dispatch_text_numbers: string[];
  dispatch_call_number: string | null;
  dispatch_call_overrides?: Record<string, string>;
  dispatch_by_type?: Record<string, {
    dispatch_text_numbers?: string[];
    dispatch_email?: string[];
    dispatch_cc?: string | null;
    dispatch_call_number?: string | null;
  }>;
  path_end_modes?: Record<string, "callback" | "transfer">;
  summary_agent_id: string | null;
  outbound_from_number: string | null;
  dispatch_email: string[] | null;
  dispatch_cc: string | null;
  resolve_type: (vars: Record<string, string>) => string;
  message_types: Record<string, MessageType>;
  default_message_type: string;
  webhook_url?: string;
  notification_greeting?: string;
  phone_fallback_to_caller?: boolean;
  hide_not_mentioned?: boolean;
  shadow_mode?: boolean;
  active?: boolean;
}

// Runtime cache maps moved to src/_cache/clients.ts
