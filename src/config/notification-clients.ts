export const ownerConfig = {
  phone: "+13017872841",
  email: "samasra93@gmail.com",
} as const;

export interface Field {
  key: string;
  label: string;
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
  agent_ids: string[];
  dispatch_numbers: string[];
  dispatch_email: string[] | null;
  dispatch_cc: string | null;
  resolve_type: (vars: Record<string, string>) => string;
  message_types: Record<string, MessageType>;
  default_message_type: string;
  phone_fallback_to_caller?: boolean;
  hide_not_mentioned?: boolean;
  shadow_mode?: boolean;
}

export const notificationClients: Record<string, ClientNotificationConfig> = {
  "pro-v": {
    name: "Pro V",
    agent_ids: ["agent_874f64ef6ad0aaa6a233be461e"],
    dispatch_numbers: ["+19517608403", "+16193007267", ownerConfig.phone],
    dispatch_email: ["info@provcontracting.com", ownerConfig.email],
    dispatch_cc: null, // removed — dispatch@provcontracting.com mailbox doesn't exist, was causing delivery_delayed
    resolve_type: (vars) => {
      if (vars.is_emergency === "true") return "emergency";
      return "service_request";
    },
    message_types: {
      emergency: {
        label: "EMERGENCY CALL",
        subject_template:
          "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
        additional_text: "Caller expects contact within 10 minutes.",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
        ],
      },
      service_request: {
        label: "New Service Request",
        subject_template:
          "Service Request: {{full_name}} — {{street_address}}, {{city}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
          { key: "preferred_time", label: "Preferred Time" },
          { key: "preferred_day", label: "Preferred Day" },
        ],
      },
    },
    default_message_type: "service_request",
    phone_fallback_to_caller: true,
    shadow_mode: true,
  },
  test: {
    name: "Test Client",
    agent_ids: [],
    dispatch_numbers: [ownerConfig.phone],
    dispatch_email: [ownerConfig.email],
    dispatch_cc: null,
    resolve_type: (vars) => {
      if (vars.is_emergency === "true") return "emergency";
      return "service_request";
    },
    message_types: {
      emergency: {
        label: "EMERGENCY CALL",
        subject_template:
          "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
        additional_text: "Caller expects contact within 10 minutes.",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "problem_description", label: "Problem" },
        ],
      },
      service_request: {
        label: "New Service Request",
        subject_template:
          "Service Request: {{full_name}} — {{street_address}}, {{city}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
          { key: "preferred_time", label: "Preferred Time" },
          { key: "preferred_day", label: "Preferred Day" },
        ],
      },
    },
    default_message_type: "service_request",
    phone_fallback_to_caller: true,
    shadow_mode: true,
  },
  "j-a": {
    name: "J&A Fleet Maintenance",
    agent_ids: ["agent_a7155fa14c995df72b2144b88a"],
    dispatch_numbers: ["+18152073809", "+15748708959", ownerConfig.phone],
    dispatch_email: ["Dispatch@JAFleet.com", ownerConfig.email],
    dispatch_cc: null,
    resolve_type: () => "mobile_emergency",
    message_types: {
      mobile_emergency: {
        label: "EMERGENCY REPAIR CALL",
        subject_template:
          "Emergency: {{company_name}} — {{breakdown_location}}",
        fields: [
          { key: "company_name", label: "Company" },
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "phone_number_extension", label: "Phone Ext" },
          { key: "truck_number", label: "Truck #" },
          { key: "driver_name", label: "Driver Name" },
          { key: "driver_phone", label: "Driver Phone" },
          { key: "driver_phone_extension", label: "Driver Phone Ext" },
          { key: "breakdown_location", label: "Breakdown Location" },
          { key: "problem_description", label: "Problem" },
          { key: "vehicle_type", label: "Vehicle Type" },
          { key: "vehicle_manufacturer", label: "Vehicle Make" },
          { key: "vehicle_color", label: "Vehicle Color" },
          {
            key: "is_loaded",
            label: "Is it Loaded?",
            show_when: { field: "load_weight_collected", equals: "true" },
            format: "yes_no",
          },
          {
            key: "load_weight",
            label: "Load Weight",
            show_when: { field: "load_weight_collected", equals: "true" },
          },
          { key: "whos_paying", label: "Who's Paying" },
          { key: "payment_method", label: "Payment Method" },
        ],
      },
    },
    default_message_type: "mobile_emergency",
    phone_fallback_to_caller: true,
    hide_not_mentioned: true,
    shadow_mode: true,
  },
  "rapid-care": {
    name: "Rapid Care Truck Repair",
    agent_ids: ["agent_22cb78c4ce16e8a470ed6bce8d"],
    dispatch_numbers: ["+18152073809", "+15748708959", ownerConfig.phone],
    dispatch_email: ["Dispatch@JAFleet.com", ownerConfig.email],
    dispatch_cc: null,
    resolve_type: () => "mobile_emergency",
    message_types: {
      mobile_emergency: {
        label: "EMERGENCY REPAIR CALL",
        subject_template:
          "Emergency: {{company_name}} — {{breakdown_location}}",
        fields: [
          { key: "company_name", label: "Company" },
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "phone_number_extension", label: "Phone Ext" },
          { key: "truck_number", label: "Truck #" },
          { key: "driver_name", label: "Driver Name" },
          { key: "driver_phone", label: "Driver Phone" },
          { key: "driver_phone_extension", label: "Driver Phone Ext" },
          { key: "breakdown_location", label: "Breakdown Location" },
          { key: "problem_description", label: "Problem" },
          { key: "vehicle_type", label: "Vehicle Type" },
          { key: "vehicle_manufacturer", label: "Vehicle Make" },
          { key: "vehicle_color", label: "Vehicle Color" },
          {
            key: "is_loaded",
            label: "Is it Loaded?",
            show_when: { field: "load_weight_collected", equals: "true" },
            format: "yes_no",
          },
          {
            key: "load_weight",
            label: "Load Weight",
            show_when: { field: "load_weight_collected", equals: "true" },
          },
          { key: "whos_paying", label: "Who's Paying" },
          { key: "payment_method", label: "Payment Method" },
        ],
      },
    },
    default_message_type: "mobile_emergency",
    phone_fallback_to_caller: true,
    hide_not_mentioned: true,
    shadow_mode: true,
  },
  test_prod: {
    name: "Test Client (Prod)",
    agent_ids: [],
    dispatch_numbers: [ownerConfig.phone],
    dispatch_email: [ownerConfig.email],
    dispatch_cc: null,
    resolve_type: (vars) => {
      if (vars.is_emergency === "true") return "emergency";
      return "service_request";
    },
    message_types: {
      emergency: {
        label: "EMERGENCY CALL",
        subject_template:
          "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
        additional_text: "Caller expects contact within 10 minutes.",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "problem_description", label: "Problem" },
        ],
      },
      service_request: {
        label: "New Service Request",
        subject_template:
          "Service Request: {{full_name}} — {{street_address}}, {{city}}",
        fields: [
          { key: "full_name", label: "Name" },
          { key: "phone_number", label: "Phone" },
          { key: "street_address", label: "Address" },
          { key: "city", label: "City" },
          { key: "problem_description", label: "Problem" },
          { key: "preferred_time", label: "Preferred Time" },
          { key: "preferred_day", label: "Preferred Day" },
        ],
      },
    },
    default_message_type: "service_request",
    phone_fallback_to_caller: true,
    shadow_mode: true,
  },
};

// Build agent_id → client lookup map
export const agentIdToClient: Record<string, ClientNotificationConfig> = {};
for (const client of Object.values(notificationClients)) {
  for (const agentId of client.agent_ids) {
    agentIdToClient[agentId] = client;
  }
}
