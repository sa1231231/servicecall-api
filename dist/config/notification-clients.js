export const notificationClients = {
    "pro-v": {
        client_id: "pro-v",
        name: "Pro V Contracting",
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
                subject_template: "EMERGENCY: {{full_name}} — {{address}}",
                additional_text: "Caller expects contact within 10 minutes.",
            },
            service_request: {
                label: "New Service Request",
                subject_template: "Service Request: {{full_name}} — {{address}}",
            },
        },
        default_message_type: "service_request",
        fields: [
            { key: "full_name", label: "Name" },
            { key: "phone_number", label: "Phone" },
            { key: "address", label: "Address" },
            { key: "problem_description", label: "Problem" },
            { key: "time_preference", label: "Preferred Time" },
        ],
        phone_fallback_to_caller: true,
    },
    test: {
        client_id: "test",
        name: "Test Client",
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
                subject_template: "EMERGENCY: {{full_name}} — {{address}}",
                additional_text: "Caller expects contact within 10 minutes.",
            },
            service_request: {
                label: "New Service Request",
                subject_template: "Service Request: {{full_name}} — {{address}}",
            },
        },
        default_message_type: "service_request",
        fields: [
            { key: "full_name", label: "Name" },
            { key: "phone_number", label: "Phone" },
            { key: "address", label: "Address" },
            { key: "problem_description", label: "Problem" },
            { key: "time_preference", label: "Preferred Time" },
        ],
        phone_fallback_to_caller: true,
    },
};
