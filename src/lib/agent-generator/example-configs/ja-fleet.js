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
    "truck_number",
    "driver_name",
    "driver_phone",
    "breakdown_location",
    "problem_description",
    "vehicle_type",
    "vehicle_manufacturer",
    "vehicle_color",
    "whos_paying",
    "payment_method",
  ],
};
