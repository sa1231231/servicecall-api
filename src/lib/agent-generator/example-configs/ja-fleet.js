module.exports = {
  config: {
    businessName: "J&A",
    faqKnowledgeBase: `
## Company Overview

Business Name: J&A Fleet Maintenance
Phone: (815) 518-5252
Email: dispatch@jafleet.com
Headquarters: Morris, IL
Certifications: DOT Certified, Fully Insured, Licensed & Bonded
Availability: 24/7 including nights, weekends, and holidays

## What J&A Fleet Does

J&A Fleet Maintenance provides emergency heavy-duty truck repair and mobile roadside assistance for commercial vehicles. Technicians are dispatched to the truck's location to diagnose and repair on-site, or coordinate towing if needed. They service semis, tractor-trailers, diesel fleets, box trucks, and commercial vehicles of all makes and models.

## Service Area

Chicagoland and Northern Illinois including Joliet, Morris, Gardner, Rockdale, Wilmington, Pontiac, Seneca, Bolingbrook, Naperville, Aurora, and all surrounding areas.

## What the Agent Needs to Know

Response time is typically 30 to 60 minutes depending on location.
Technicians come to the truck — mobile service, not a shop-only operation.
Towing can be coordinated on the same bill if on-site repair isn't possible.
J&A works with fleet accounts, owner-operators, and third-party breakdown services.
Pricing depends on the repair and location — the agent does not quote prices.
If asked about hours of service concerns, J&A can prioritize fast dispatch or coordinate a tow.

## Frequently Asked Questions

How fast can you get someone out?
Typically 30 to 60 minutes depending on location.

Do you work 24/7?
Yes.

What do you work on?
All commercial trucks — semis, tractor-trailers, diesel fleets, box trucks.

How much does it cost?
Pricing depends on the repair and location. The dispatch team will provide that.

Can you tow it?
Yes, towing partners are available and can be billed together with the repair.

Can you fix it on the road?
In most cases yes. If it needs a shop, that gets coordinated too.
`,

    introFinetuneExamples: [
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "What areas do you guys cover?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "How much do you charge for a service call?", role: "user" },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Who is this?", role: "user" },
          {
            content: "This is Anthony with J&A Fleet. How can I help you?",
            role: "agent",
          },
        ],
      },
    ],
  },

  dataPoints: [
    "company_name",
    "full_name",
    "phone_number",
    {
      variableName: "truck_number",
      label: "Truck Number",
      type: "string",
      description:
        'The fleet vehicle identifier (e.g., "Truck 124", "Unit 87"). If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller for the truck number or unit number of the vehicle that needs service.",
      forwardCondition: "The caller has provided the truck number",
      extractSuccessEquation: [
        { left: "{{truck_number}}", operator: "exists" },
        { left: "{{truck_number}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
    {
      variableName: "driver_name",
      label: "Driver Name",
      type: "string",
      description:
        'The name of the driver who is with the vehicle. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller for the name of the driver who is with the truck.",
      forwardCondition: "The caller has provided the driver's name",
      extractSuccessEquation: [
        { left: "{{driver_name}}", operator: "exists" },
        { left: "{{driver_name}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
    {
      variableName: "driver_phone",
      label: "Driver Phone Number",
      type: "string",
      description:
        'The phone number where the driver can be reached directly. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller for the driver's direct phone number so the technician can reach them.\n\nRepeat the number back to confirm you have it right.",
      forwardCondition: "The caller has provided the driver's phone number",
      finetuneExamples: [
        {
          type: "negative",
          transcript: [
            {
              content: "Driver's number is eight six seven five three zero nine.",
              role: "user",
            },
            {
              content:
                "I'm sorry, I don't think I heard the complete phone number. Could you repeat all ten digits for me?",
              role: "agent",
            },
          ],
        },
      ],
      extractSuccessEquation: [
        { left: "{{driver_phone}}", operator: "exists" },
        { left: "{{driver_phone}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
    {
      variableName: "breakdown_location",
      label: "Location",
      type: "string",
      description:
        'Where the truck is broken down. This could be a truck stop name, highway and mile marker, city, cross streets, or any description the caller provides. Capture as much detail as given. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller where the truck is located.\n\nThey can give a truck stop name, highway and mile marker, city, cross streets, or whatever details they have. Get as much location detail as possible so the technician can find the truck.",
      forwardCondition: "The caller has described where the truck is located",
      extractSuccessEquation: [
        { left: "{{breakdown_location}}", operator: "exists" },
        { left: "{{breakdown_location}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
    {
      variableName: "problem_description",
      label: "Problem Description",
      type: "string",
      description:
        'A description of what is wrong with the truck (e.g., won\'t start, clicking noise, overheating, flat tire, alternator issue). Capture the caller\'s description in their own words. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller what's going on with the truck — what problem are they experiencing?\n\nLet them describe it in their own words. You don't need to diagnose anything, just capture what they tell you.",
      forwardCondition: "The caller has described the problem with the truck",
      extractSuccessEquation: [
        { left: "{{problem_description}}", operator: "exists" },
        { left: "{{problem_description}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
    {
      variableName: "whos_paying",
      label: "Who's Paying",
      type: "string",
      description:
        'Who is responsible for the bill — could be the company, the driver (owner-operator), or a third-party fleet account. Capture whatever the caller says. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller who will be responsible for the bill on this service call.",
      forwardCondition: "The caller has indicated who is paying for the service",
      extractSuccessEquation: [
        { left: "{{whos_paying}}", operator: "exists" },
        { left: "{{whos_paying}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
  ],
};
