module.exports = {
  config: {
    businessName: "Your Business Name",
    faqKnowledgeBase: `## Company Overview
- Business Name: Your Business Name
- Location: City, State
- Type: Description of business

## Services Offered
- Service 1
- Service 2

## Pricing
- Pricing details here

## Key Details
- Important detail 1
- Important detail 2`,

    // ── Intro Node Finetune Examples ─────────────────────────────────────
    // Each example is labeled type: "positive" (should transition out)
    // or type: "negative" (should stay in this node).
    //
    // Positive examples need a destination:
    //   "__faq__"     → route to FAQ node
    //   "__extract__" → route to extraction flow (start collecting info)
    //
    // Negative examples have no destination — the agent stays and responds.

    introFinetuneExamples: [
      // ── Positive: route to FAQ node ──
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "How much do you charge?", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__faq__",
        transcript: [
          { content: "What areas do you service?", role: "user" },
        ],
      },

      // ── Positive: route to extraction (caller is ready to proceed) ──
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          { content: "I need to schedule a service call.", role: "user" },
        ],
      },
      {
        type: "positive",
        destination: "__extract__",
        transcript: [
          { content: "Yeah I'd like to get a quote please.", role: "user" },
        ],
      },

      // ── Negative: stay in Intro, don't transition ──
      {
        type: "negative",
        transcript: [
          { content: "Who is this?", role: "user" },
          {
            content:
              "This is Anthony with Your Business Name. How can I help you today?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Hey, good morning.", role: "user" },
          {
            content:
              "Good morning! How can I help you?",
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
              "I'm an AI assistant for Your Business Name. I can help you get started — what can I do for you?",
            role: "agent",
          },
        ],
      },
    ],
  },

  dataPoints: [
    "full_name",
    "phone_number",
    // "email",
    // "city",
    // "street_address",
    // "company_name",

    // ── Custom data point with finetune examples ────────────────────────
    // Positive = caller gave enough info, should transition to next step.
    // Negative = caller's answer is incomplete, agent should stay and clarify.
    {
      variableName: "number_of_dogs",
      label: "Number of Dogs",
      type: "string",
      description:
        'How many dogs the caller has. If not mentioned, set to "Not Mentioned".',
      conversationPrompt: "How many dogs do you have?",
      forwardCondition: "The caller has provided the number of dogs.",
      finetuneExamples: [
        // ── Positive: caller answered clearly, transition ──
        {
          type: "positive",
          transcript: [
            { content: "I have 3 dogs.", role: "user" },
          ],
        },
        {
          type: "positive",
          transcript: [
            { content: "Just one.", role: "user" },
          ],
        },

        // ── Negative: vague or incomplete answer, stay and clarify ──
        {
          type: "negative",
          transcript: [
            { content: "I'm not sure, maybe a few?", role: "user" },
            {
              content:
                "No problem — can you give me an approximate number?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "A lot.", role: "user" },
            {
              content:
                "Ha, understood. Do you have a rough count — like 2, 5, 10?",
              role: "agent",
            },
          ],
        },
      ],
      extractSuccessEquation: [
        { left: "{{number_of_dogs}}", operator: "exists" },
        { left: "{{number_of_dogs}}", operator: "!=", right: "Not Mentioned" },
      ],
    },

    // ── Another custom data point example ───────────────────────────────
    {
      variableName: "preferred_date",
      label: "Preferred Date",
      type: "string",
      description:
        'The date the caller would like to schedule service. If not mentioned, set to "Not Mentioned".',
      conversationPrompt:
        "What date works best for you?",
      forwardCondition: "The caller has provided a preferred date.",
      finetuneExamples: [
        {
          type: "positive",
          transcript: [
            { content: "This Friday works.", role: "user" },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "Sometime next week I guess.", role: "user" },
            {
              content:
                "Sure, is there a specific day next week that works best?",
              role: "agent",
            },
          ],
        },
        {
          type: "negative",
          transcript: [
            { content: "Whenever you have availability.", role: "user" },
            {
              content:
                "We're pretty flexible. Do you have a day in mind — like this week or next week?",
              role: "agent",
            },
          ],
        },
      ],
      extractSuccessEquation: [
        { left: "{{preferred_date}}", operator: "exists" },
        { left: "{{preferred_date}}", operator: "!=", right: "Not Mentioned" },
      ],
    },
  ],
};
