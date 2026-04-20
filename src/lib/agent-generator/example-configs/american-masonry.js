module.exports = {
  config: {
    businessName: "American Masonry",
    faqKnowledgeBase: `
## Company Info
- Business Name: American Masonry
- Phone: (248) 747-2867
- Address: 26844 Belleair St, Roseville, MI 48066
- Experience: 40+ years in masonry
- Availability: 24/7 including emergency service

## Service Area
- Oakland County, Macomb County, Genesee County, and Wayne County, Michigan
- Includes Pontiac, Roseville, and surrounding cities

## What We Do
American Masonry Construction provides residential, commercial, and industrial masonry services. They are also restoration experts.

## Services Offered

### Brick Work
- Brick repair
- Brick replacement
- Brick cleaning
- Tuckpointing (mortar joint repair)
- Brick wall construction

### Chimney Services
- Chimney repair
- Chimney cap replacement
- Chimney restoration
- Chimney rebuild

### Stone and Concrete
- Stone repair and installation
- Block and concrete work
- Foundation repair

### Restoration
- Brick restoration
- Stone restoration
- Historic masonry restoration
- Water damage masonry repair

### Additional Services
- Porch repair and rebuild
- Steps and stairway repair
- Commercial masonry
- Industrial masonry
- Emergency masonry service (24/7)

## Customer Types
- Residential homeowners
- Commercial property owners
- Industrial facilities
- Restaurants (after-hours work available)
- Realtors and property managers
`,
    introFinetuneExamples: [
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "How much do you charge?", role: "user" }],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "What areas do you cover?", role: "user" }],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [{ content: "Do you do chimney work?", role: "user" }],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "Are you available on weekends?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "Do you work with commercial buildings?", role: "user" },
        ],
      },

      // ── Positive: route to extraction (caller is ready to proceed) ──
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "I need someone to come look at my chimney.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "I've got some bricks falling off my house.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          { content: "Yeah I'd like to get an estimate please.", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "I've got an emergency, my chimney is collapsing.",
            role: "user",
          },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          {
            content: "I need some tuckpointing done on my house.",
            role: "user",
          },
        ],
      },

      {
        type: "negative",
        transcript: [
          { content: "Hey, good morning.", role: "user" },
          {
            content: "Good morning! How can I help you?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Is this a real person?", role: "user" },
          {
            content:
              "I'm an AI assistant for American Masonry. But I can help you with your request. What can I do for you?",
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
      variableName: "work_description",
      label: "Work Description",
      type: "string",
      description:
        'A description of what the caller needs done. Examples: chimney repair, brick repair, tuckpointing, porch rebuild, stone work, restoration, foundation repair. Capture the caller\'s description in their own words. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller what kind of masonry work they need done.\n\nLet them describe it in their own words. You don't need to diagnose anything, just capture what they tell you.",
      forwardCondition: "The caller has described what work they need",
      finetuneExamples: [
        {
          type: "positive",
          transcript: [
            {
              content: "My chimney cap is missing and I need it replaced.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content: "I need tuckpointing on the front of my house.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            { content: "Some bricks are falling off my porch.", role: "user" },
          ],
        },
        {
          type: "positive",
          transcript: [
            { content: "I need a full chimney rebuild.", role: "user" },
          ],
        },
        {
          type: "negative",
          transcript: [
            {
              content:
                "I'm not sure exactly, something is wrong with the bricks.",
              role: "user",
            },
            {
              content:
                "No problem. Can you tell me a little more? Like are the bricks cracking, falling out, or is the mortar crumbling?",
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
                "Absolutely. Can you give me a rough idea of what area of the property needs attention? Like the chimney, porch, or walls?",
              role: "agent",
            },
          ],
        },
      ],
      extractSuccessEquation: [
        { left: "{{work_description}}", operator: "exists" },
        {
          left: "{{work_description}}",
          operator: "!=",
          right: "Not Mentioned",
        },
      ],
    },
    {
      variableName: "is_emergency",
      label: "Emergency",
      type: "string",
      description:
        'Whether this is an emergency requiring immediate attention or a non-emergency request for an estimate. Examples of emergency: chimney collapsing, active water coming through brick, structural safety concern. Examples of non-emergency: want an estimate for tuckpointing, chimney cap replacement, porch rebuild. Set to "Emergency" or "Non-Emergency". If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "Ask the caller if this is an emergency that needs attention right away, or if they'd like to schedule a time for an estimate.",
      forwardCondition:
        "The caller has indicated whether this is an emergency or not",
      finetuneExamples: [
        {
          type: "positive",
          transcript: [
            {
              content: "It's an emergency, bricks are falling off right now.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content: "No rush, I just want to get an estimate.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content: "Yeah it's urgent, water is coming through the wall.",
              role: "user",
            },
          ],
        },
        {
          type: "positive",
          transcript: [
            {
              content: "Not an emergency, just want to get it looked at.",
              role: "user",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            {
              content: "I mean it's been like this for a while.",
              role: "user",
            },
            {
              content:
                "Got it. So it sounds like it's not an immediate emergency. Would you like to schedule a time for us to come out and take a look?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "I don't know, it looks pretty bad.", role: "user" },
            {
              content:
                "I understand. Is there any active damage happening right now, like bricks falling or water coming in? Or has it been like this for a little while?",
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
  ],
};
