module.exports = {
  config: {
    businessName: "Pro V",
    faqKnowledgeBase: `
    ## Company Info
- Company name: Pro V Restoration
- Phone: (888) 508-6580
- Address: 7290 Engineer Rd, STE E, San Diego, CA 92111
- License: CSLB 828011
- Fully licensed and insured
- IICRC-certified technicians
- Available 24/7 for emergencies

## Service Area
- San Diego County

## Office Hours
- Office: Monday through Friday, 8 AM to 5 PM
- Emergency response: Open 24/7, including nights, weekends, and holidays


## Services Offered

### Water Damage Mitigation
- Immediate water extraction
- Drying and dehumidification
- Prevention of further damage and mold growth

### Fire and Smoke Restoration
- Structural cleaning
- Smoke odor removal
- Full property rebuilds after fire damage

### Mold Remediation
- Safe removal of hazardous mold
- Industry-standard containment and sanitation practices

### Storm and Flood Recovery
- Cleanup and restoration after wind, rain, or flood damage

### Pack-Out Services
- Carefully pack, store, and restore personal belongings during restoration


## FAQ

**Q: Do you offer free estimates?**
A: Yes. We offer free, no-obligation estimates for all restoration services. We can schedule an assessment once we have your information.

**Q: Can you help with insurance claims?**
A: Yes. We have experienced estimators and claims specialists on staff. We handle the paperwork, documentation, and direct communication with your insurance company. We guide you through the entire claims process.

**Q: How fast can you respond?**
A: We offer 24/7 emergency response and aim to be on-site as quickly as possible, often within hours.

**Q: What kind of equipment do you use?**
A: Thermal imaging, air scrubbers, moisture meters, and advanced diagnostics equipment for accurate assessment and efficient recovery.

**Q: Do you handle the full rebuild or just the cleanup?**
A: Both. We handle emergency cleanup and the full rebuild so you don't have to juggle multiple contractors.`,

    introFinetuneExamples: [
      // ── Positive: route to FAQ node ──
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "Do you guys do free estimates?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "Do you work with insurance?", role: "user" }],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          {
            content: "How much does water damage restoration cost?",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          {
            content: "Do you charge for coming out to look at it?",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "Do you deal with insurance companies?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          {
            content: "Will my homeowner's insurance cover this?",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "Do you guys service the La Jolla area?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "How far out do you go from San Diego?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "Do you handle mold removal?", role: "user" }],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          {
            content: "Can you do the rebuild too or just the cleanup?",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "Do you guys do fire damage restoration?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "How fast can you get someone out here?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "Are you open right now?", role: "user" }],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "Are you guys licensed?", role: "user" }],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "Are your technicians certified?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "What kind of equipment do you use?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "Do you do storm damage?", role: "user" }],
      },

      // ── Positive: route to extraction (caller ready to proceed) ──
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "I've got water pouring into my living room right now.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "My basement is flooding, I need someone out here now.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "A pipe burst in my kitchen and water is everywhere.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "We just had a fire and need restoration help.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "There's water coming through my ceiling right now.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "I had a water leak last week and need someone to come assess the damage.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "We found mold in our bathroom and need it taken care of.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "I need to schedule someone to come look at water damage in my house.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "Yeah I'd like to get someone out for an estimate on some water damage.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "We had storm damage last night and need help.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "My property manager told me to call you about water damage in one of our units.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "My insurance company said I need to get a restoration company out here.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "I need help with smoke damage in my house from a kitchen fire.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "The toilet overflowed and now the whole bathroom floor is soaked.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "Our water heater burst and flooded the garage.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content:
              "I need someone to come out and dry everything. We had a flood.",
            role: "user",
          },
        ],
      },

      // ── Negative: stay in Intro, don't transition ──
      {
        type: "negative",
        transcript: [
          { content: "Hi, is this Pro V?", role: "user" },
          {
            content:
              "Yes it is! This is Anthony with Pro V Restoration. How can I help you today?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Hello?", role: "user" },
          {
            content:
              "Hi there! Thank you for calling Pro V Restoration, this is Anthony. How can I help you?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Hey, good evening.", role: "user" },
          {
            content: "Good evening! How can I help you?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Yeah hi, um, hold on one second.", role: "user" },
          {
            content: "No problem, take your time.",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Who am I speaking with?", role: "user" },
          {
            content:
              "This is Anthony with Pro V Restoration. How can I help you today?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Is this the restoration company?", role: "user" },
          {
            content:
              "Yes it is! This is Pro V Restoration. What can I do for you?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Am I talking to a real person?", role: "user" },
          {
            content:
              "I'm an AI assistant for Pro V Restoration. I can help you get started. What's going on?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Are you a robot?", role: "user" },
          {
            content:
              "I'm an AI assistant for Pro V Restoration. But I can absolutely help you. What do you need?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "I got your number from Google.", role: "user" },
          {
            content: "Great. What can I help you with today?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "My neighbor recommended you guys.", role: "user" },
          {
            content: "That's great to hear. What can we help you with?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          {
            content: "Yeah my insurance adjuster gave me your number.",
            role: "user",
          },
          {
            content: "Glad they did. What's going on with your property?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          {
            content: "I'm not sure if I need restoration or just a plumber.",
            role: "user",
          },
          {
            content:
              "No worries, I can help figure that out. Can you tell me what's going on?",
            role: "agent",
          },
        ],
      },
    ],
  },

  dataPoints: [
    "full_name",
    "phone_number",
    "street_address",
    {
      variableName: "problem_description",
      label: "Problem Description",
      type: "string",
      description:
        'A description of what is happening at the property (e.g., burst pipe, flooding, water leak, storm damage, fire damage, mold). Capture the caller\'s description in their own words. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller what's going on — what kind of damage or emergency are they dealing with?\n\nLet them describe it in their own words. You don't need to diagnose anything, just capture what they tell you.",
      forwardCondition: "The caller has described the problem at the property",
      finetuneExamples: [
        {
          type: "positive",
          transcript: [
            {
              content:
                "A pipe burst under the kitchen sink and the whole floor is soaked.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content:
                "We had a fire in the garage and there's smoke damage throughout the house.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content:
                "There's black mold growing behind the drywall in our bathroom.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content:
                "The roof leaked during the storm and now there's water damage in two bedrooms.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content: "Our water heater burst and the whole garage flooded.",
              role: "user",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "There's water everywhere.", role: "user" },
            {
              content:
                "Got it, water damage. Do you know where it's coming from — like a burst pipe, a leak, or flooding from outside?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            {
              content: "I don't really know, there's just damage.",
              role: "user",
            },
            {
              content:
                "No problem. Is it water damage, fire damage, mold, or something else?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            {
              content:
                "It smells bad and there's some discoloration on the wall.",
              role: "user",
            },
            {
              content:
                "That could be water damage or possibly mold. Do you know if there was a leak or any water exposure in that area?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            {
              content: "I just need someone to come look at it.",
              role: "user",
            },
            {
              content:
                "Absolutely. Can you give me a rough idea of what you're seeing? Like water, fire damage, mold, or something else?",
              role: "agent",
            },
          ],
        },
      ],
      extractSuccessEquation: [
        { left: "{{problem_description}}", operator: "exists" },
        {
          left: "{{problem_description}}",
          operator: "!=",
          right: "Not Mentioned",
        },
      ],
    },
    {
      variableName: "is_emergency",
      label: "Is Emergency",
      type: "boolean",
      description:
        'Whether this is an active emergency right now or a past event. Examples of active: water is currently flowing, flooding is happening now, smoke or fire present. Examples of non-urgent: water damage happened yesterday, mold discovered during inspection, requesting an estimate. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller if this is happening right now or if this is something that already happened.\n\nIf water is actively flowing or there is an active emergency, let them know we will prioritize getting someone out as fast as possible.",
      forwardCondition:
        "The caller has indicated whether this is an active emergency or not",
      finetuneExamples: [
        {
          type: "positive",
          transcript: [
            {
              content: "It's happening right now, water is still coming in.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content:
                "No, it happened a couple days ago. We just need someone to assess it.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content: "Yeah it's active, the pipe is still leaking.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content:
                "The fire was last week but we need the restoration done.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content:
                "We turned the water off but everything is still soaked.",
              role: "user",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "I mean, it's been wet for a while.", role: "user" },
            {
              content:
                "Got it. Is water still actively coming in, or has the leak stopped and you're dealing with the damage left behind?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "I'm not sure how bad it is.", role: "user" },
            {
              content:
                "No worries. Is this something that's happening right now, or did the damage already occur and you need someone to come take a look?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "It's been like this for a few days.", role: "user" },
            {
              content:
                "Understood. So the immediate emergency has passed and you need someone to come out and assess the damage. Is that right?",
              role: "agent",
            },
          ],
        },
      ],
      extractSuccessEquation: [
        { left: "{{is_emergency}}", operator: "exists" },
        { left: "{{is_emergency}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
    "scheduling",
  ],
};
