export const notificationClients = {
    "pro-v": {
        client_id: "pro-v",
        name: "Pro V Contracting",
        agent_ids: [],
        dispatch_numbers: ["+19517608403", "+16193007267"],
        dispatch_email: "info@provcontracting.com",
        dispatch_cc: "dispatch@provcontracting.com",
        resolve_type: (vars) => {
            if (vars.is_emergency === "true")
                return "emergency";
            return "service_request";
        },
        message_types: {
            emergency: {
                label: "EMERGENCY CALL",
                subject_template: "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
                additional_text: "Caller expects contact within 10 minutes.",
            },
            service_request: {
                label: "New Service Request",
                subject_template: "Service Request: {{full_name}} — {{street_address}}, {{city}}",
            },
        },
        default_message_type: "service_request",
        fields: [
            { key: "full_name", label: "Name" },
            { key: "phone_number", label: "Phone" },
            { key: "street_address", label: "Address" },
            { key: "city", label: "City" },
            { key: "problem_description", label: "Problem" },
            { key: "preferred_time", label: "Preferred Time" },
            { key: "preferred_day", label: "Preferred Day" },
        ],
        phone_fallback_to_caller: true,
    },
    test: {
        client_id: "test",
        name: "Test Client",
        agent_ids: ["agent_c61bdb14aa746b303648c5346d"],
        dispatch_numbers: ["+13017872841"],
        dispatch_email: "samasra93@gmail.com",
        dispatch_cc: null,
        resolve_type: (vars) => {
            if (vars.is_emergency === "true")
                return "emergency";
            return "service_request";
        },
        message_types: {
            emergency: {
                label: "EMERGENCY CALL",
                subject_template: "EMERGENCY: {{full_name}} — {{street_address}}, {{city}}",
                additional_text: "Caller expects contact within 10 minutes.",
            },
            service_request: {
                label: "New Service Request",
                subject_template: "Service Request: {{full_name}} — {{street_address}}, {{city}}",
            },
        },
        default_message_type: "service_request",
        fields: [
            { key: "full_name", label: "Name" },
            { key: "phone_number", label: "Phone" },
            { key: "street_address", label: "Address" },
            { key: "city", label: "City" },
            { key: "problem_description", label: "Problem" },
            { key: "preferred_time", label: "Preferred Time" },
            { key: "preferred_day", label: "Preferred Day" },
        ],
        phone_fallback_to_caller: true,
    },
};
// Build agent_id → client lookup map
export const agentIdToClient = {};
for (const client of Object.values(notificationClients)) {
    for (const agentId of client.agent_ids) {
        agentIdToClient[agentId] = client;
    }
}
