// ── Types ────────────────────────────────────────────────────────────────────

export interface FinetuneExample {
  type: "positive" | "negative";
  transcript: Array<{ content: string; role: "user" | "agent" }>;
  destination?: string;
  id?: string;
}

export interface ExtractEquation {
  left: string;
  operator: string;
  right?: string;
}

export interface VariableDef {
  variableName: string;
  type: "string" | "enum" | "boolean";
  choices?: string[];
  description: string;
}

export interface DataPoint {
  composite?: boolean;
  label: string;
  variableName: string;
  type: "string" | "enum" | "boolean";
  choices?: string[];
  description: string;
  conversationPrompt: string;
  forwardCondition: string;
  finetuneExamples?: FinetuneExample[];
  extractSuccessEquation: ExtractEquation[];
  // Composite-only
  variables?: VariableDef[];
}

export type RawDataPoint = string | Partial<DataPoint> & { variableName?: string; composite?: boolean; variables?: VariableDef[] };

// ── Built-in Data Point Registry ─────────────────────────────────────────────

export const DATA_POINT_REGISTRY: Record<string, DataPoint> = {
  full_name: {
    label: "Full Name",
    variableName: "full_name",
    type: "string",
    choices: [],
    description: `Full name of the caller. If the caller does not specifically mention their name, set to "Not Mentioned".`,
    conversationPrompt: `Your goal is to collect the caller's full name by asking: "Can I get your name please?"

If the caller is correcting your spelling, correct the spelling and re-confirm.`,
    forwardCondition: "The caller has given you their name",
    finetuneExamples: [
      {
        type: "negative",
        transcript: [
          { content: "It's John.", role: "user" },
          { content: "Got it, and your last name?", role: "agent" },
        ],
      },
    ],
    extractSuccessEquation: [
      { left: "{{full_name}}", operator: "exists" },
      { left: "{{full_name}}", operator: "!=", right: "Not Mentioned" },
    ],
  },
  phone_number: {
    label: "Phone Number",
    variableName: "phone_number",
    type: "string",
    choices: [],
    description: `Phone number of the caller. Convert any spoken digits to numeric format (e.g., 'three one two five five five one two three four' becomes '312-555-1234'). If not mentioned, set to "Not Mentioned".`,
    conversationPrompt: `Ask the caller if the current number they're calling from is the best number to reach them by saying "Is this the best number to reach you at?"

Wait for their reply.

If the caller gives you an incomplete phone number, ask for it again.

Phone Number Readback Rules:
Format
\t•\tArea code
\t•\tPrefix
\t•\tLine number

Example
\t•\tCaller says: 214-555-1234
\t•\tRead back as:
"Two one four… five five five… one two three four."

\t•\tDigits are read individually, never as full numbers.
\t•\tInsert a ~475-550 ms pause between each section.
\t•\tDo not add country codes unless the caller explicitly states one.

Pacing
\t•\tTarget speed: 2.5-3.2 characters per second
\t•\tThis is slower than conversational speech but still natural.
    `,
    forwardCondition: "You have the caller's best number to reach them.",
    finetuneExamples: [
      {
        type: "negative",
        transcript: [
          {
            content: "My number is eight six seven five three zero nine.",
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
      { left: "{{phone_number}}", operator: "exists" },
      { left: "{{phone_number}}", operator: "!=", right: "Not Mentioned" },
    ],
  },
  email: {
    label: "Email",
    variableName: "email",
    type: "string",
    choices: [],
    description: `Email address of the caller. If not mentioned, set to "Not Mentioned".`,
    conversationPrompt: `Ask the caller for their email address.

Spell it back to confirm you have it right.`,
    forwardCondition: "The caller has given you their email address",
    extractSuccessEquation: [
      { left: "{{email}}", operator: "exists" },
      { left: "{{email}}", operator: "!=", right: "Not Mentioned" },
    ],
  },
  street_address: {
    label: "Street Address",
    variableName: "street_address",
    type: "string",
    choices: [],
    description: `The physical street address. Extract only the street number and street name (e.g., "123 Main Street"). Do not include city, state, or zip code. If not mentioned, set to "Not Mentioned"`,
    conversationPrompt: `Ask the caller for their street address.

If the caller provides incomplete information:
- Missing street number → ask for the street number.
- Missing street name → ask for the street name.

Once you have the full address, read it back slowly using this format:

### Street Number
- NEVER read as a full number (e.g. never say "seven thousand three hundred thirty-eight")
- Always read street numbers digit by digit

### Street Name
Spell it out letter by letter

### Full Read-Back Example:
If caller says "7338 Maple Avenue", respond:
"Got it, so just to confirm, that's 7338, M-A-P-L-E Avenue, is that correct?

## Corrections
If the caller corrects any part:
1. Acknowledge the correction
2. Read back the corrected address in the same format
3. Wait for confirmation again

##
Do not ask for any other information than what is instructed for this node.`,
    forwardCondition: "You have confirmed the caller's street address.",
    extractSuccessEquation: [
      { left: "{{street_address}}", operator: "exists" },
      { left: "{{street_address}}", operator: "!=", right: "Not Mentioned" },
    ],
  },
  city: {
    label: "City",
    variableName: "city",
    type: "string",
    choices: [],
    description: `The city of the property. Extract only the city name (e.g., "Los Angeles"). Do not include state or zip code. If not mentioned, set to "Not Mentioned".`,
    conversationPrompt: `Ask the caller for their city by saying "Which city are you in?"

Refer to the system prompt for list of cities we service.

##
Do not ask for any other information than what is instructed for this node.`,
    forwardCondition: "The caller has given you their city",
    extractSuccessEquation: [
      { left: "{{city}}", operator: "exists" },
      { left: "{{city}}", operator: "!=", right: "Not Mentioned" },
    ],
  },
  company_name: {
    label: "Company Name",
    variableName: "company_name",
    type: "string",
    choices: [],
    description: `The name of the caller's company or business. If not mentioned, set to "Not Mentioned".`,
    conversationPrompt: `Ask the caller for their company or business name by asking: "May I get the company name?"`,
    forwardCondition: "The caller has given you their company name",
    extractSuccessEquation: [
      { left: "{{company_name}}", operator: "exists" },
      { left: "{{company_name}}", operator: "!=", right: "Not Mentioned" },
    ],
  },
  scheduling: {
    composite: true,
    label: "Day / Time Preference",
    variableName: "scheduling",
    type: "string",
    description: "",
    variables: [
      {
        variableName: "preferred_day",
        type: "enum",
        choices: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Not Mentioned",
        ],
        description: `The day the caller would like us to come out and see them. If they say "as soon as possible" or "right away" or "now," set to "the current day which is {{current_time_America/Los_Angeles}}." If they say or imply a specific day of the week, use that day. If not mentioned, set to "Not Mentioned".`,
      },
      {
        variableName: "preferred_time",
        type: "enum",
        choices: [
          "8 AM - 10 AM",
          "10 AM - 12 PM",
          "12 PM - 2 PM",
          "2 PM - 4 PM",
          "4 PM - 6 PM",
          "Not Mentioned",
        ],
        description: `The 2-hour time window the caller prefers. If the caller gives a specific time like "around 3," map to the closest window (2 PM - 4 PM). If they say "morning," use "8 AM - 10 AM." If they say "afternoon," use "12 PM - 2 PM." If they say "evening" or "later in the day," use "4 PM - 6 PM." If not mentioned, set to "Not Mentioned".`,
      },
    ],
    conversationPrompt: `Your goal is to find out when the caller would like someone to come out, and confirm a a day and 2-hour time window.

Start by asking: "When would you like us to come out?"

Based on their response, guide them to a specific 2-hour window.

Available windows:
- 8 to 10 AM
- 10 AM to 12 PM
- 12 to 2 PM
- 2 to 4 PM
- 4 to 6 PM


Rules:
- The earliest available window must be at least 2 hours from right now. If it is currently 9 AM, the earliest you can offer is 12 to 2 PM. If it is currently 1 PM, the earliest you can offer is 4 to 6 PM.

- If no windows remain today because it is too late, offer tomorrow starting from the 8 to 10 AM window.

- If the caller says "now" or "as soon as possible" or "right away," offer the earliest available window that is at least 2 hours out. For example: "The earliest we can get someone out is between 12 and 2 today. Does that work?"

- If the caller gives a general time of day like "mornings" or "afternoons" or "evenings," pick the matching window and confirm it. For example: "How about tomorrow morning, between 8 and 10?"

- If the caller gives a specific day but no time, ask: "Do mornings or afternoons work better?"

- If the caller gives a specific time like "around 3," map it to the closest window: "Got it, how about between 2 and 4?"
- Only offer windows on Monday through Saturday. No Sundays.

Do not offer more than 3 window options at a time.

##
Do not ask for any other information than what is instructed for this node.`,
    forwardCondition:
      "The caller's has agreed to one of your day and time slot options.",
    finetuneExamples: [
      {
        type: "positive",
        transcript: [
          {
            content: "How about Tuesday between 2 and 4?",
            role: "agent",
          },
          { content: "That works.", role: "user" },
        ],
      },
      {
        type: "positive",
        transcript: [
          {
            content:
              "Can you do Thursday morning, like between 8 and 10?",
            role: "agent",
          },
          { content: "Yeah that's fine.", role: "user" },
        ],
      },
      {
        type: "positive",
        transcript: [
          {
            content: "Tomorrow afternoon between 12 and 2?",
            role: "agent",
          },
          { content: "Sure, that works for me.", role: "user" },
        ],
      },
      {
        type: "positive",
        transcript: [
          { content: "Monday between 10 and 12 works for me.", role: "user" },
        ],
      },
      {
        type: "positive",
        transcript: [
          { content: "Saturday, 8 to 10 AM.", role: "user" },
        ],
      },
      {
        type: "positive",
        transcript: [
          {
            content:
              "The earliest we can get someone out is between 12 and 2 today. Does that work?",
            role: "agent",
          },
          { content: "Yeah let's do that.", role: "user" },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "As soon as possible.", role: "user" },
          {
            content:
              "The earliest we can get someone out is between 12 and 2 today. Does that work?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Maybe sometime this week?", role: "user" },
          {
            content:
              "Sure. Is there a day that works best — like Tuesday, Wednesday, or Thursday?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Mornings are better for me.", role: "user" },
          {
            content: "How about tomorrow morning, between 8 and 10?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "I'm not sure, what do you have available?", role: "user" },
          {
            content:
              "We have openings tomorrow between 8 and 10, 10 and 12, or 12 and 2. Do any of those work?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Can you come today?", role: "user" },
          {
            content:
              "Let me check. The earliest we could get someone out today would be between 4 and 6. Would that work?",
            role: "agent",
          },
        ],
      },
      {
        type: "negative",
        transcript: [
          { content: "Wednesday.", role: "user" },
          {
            content: "Wednesday works. Do mornings or afternoons work better for you?",
            role: "agent",
          },
        ],
      },
    ],
    extractSuccessEquation: [],
  },
};
