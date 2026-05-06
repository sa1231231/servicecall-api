export const MOSS_AGENT_ID = "agent_c222d101ea95775695c5e2312d";
export const MOSS_SLUG = "moss-s-heating-and-cooling";
export const MOSS_FIXTURE = {
    slug: MOSS_SLUG,
    agentId: MOSS_AGENT_ID,
    scenarios: [
        {
            pathName: "service_call",
            scenarioName: "happy_service_call",
            description: "Caller reports a broken AC, agent collects contact info + scheduling",
            triggerMessage: "Hi, my air conditioner stopped working and I need a service call.",
            replies: {
                full_name: "Robert Chen",
                phone_number: "+15555550144",
                street_address: "742 Evergreen Terrace",
                preferred_day: "Wednesday",
            },
            fillerReply: "Yes please, go ahead.",
            expectVariables: {
                full_name: /robert\s*chen/i,
                // LLM normalizes phone differently across runs (with/without country code,
                // with/without dashes). Match on the trailing 4 digits which always survive.
                phone_number: /0144/,
                preferred_day: /wednesday/i,
            },
            expectMessageTypeKey: "service_call",
        },
        {
            pathName: "new_install_consultation",
            scenarioName: "happy_new_install",
            description: "Caller wants a quote for new HVAC installation",
            triggerMessage: "I'd like to get a quote for installing a new HVAC system.",
            replies: {
                full_name: "Patricia Lopez",
                phone_number: "+15555550177",
                street_address: "1138 Oak Street",
            },
            fillerReply: "Sure, that works.",
            expectVariables: {
                full_name: /patricia\s*lopez/i,
                phone_number: /0177/,
            },
            expectMessageTypeKey: "new_install_consultation",
        },
    ],
};
