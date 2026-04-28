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
  // Set internally by resolveDataPoints when inside a branch (can be nested)
  _branchConditions?: BranchCondition[];
}

export interface BranchCondition {
  variable: string;
  operator: "==" | "!=";
  value: string;
}

export interface BranchNode {
  _branch: true;
  variable: string;
  operator: "==" | "!=";
  value: string;
  ifChain: RawDataPoint[];
  elseChain: RawDataPoint[];
}

export type RawDataPoint = string | BranchNode | Partial<DataPoint> & { variableName?: string; composite?: boolean; variables?: VariableDef[] };

// ── Constants ────────────────────────────────────────────────────────────────

export const NOT_MENTIONED = "Not Mentioned";
export const CALLER_DOESNT_KNOW = "Caller Doesn't Know";
export const PHONE_COLLECTED_FLAG = "phone_number_collected";
export const PATH_TAKEN_VAR = "_path_taken";
export const INTERNAL_VARS = new Set([PHONE_COLLECTED_FLAG, PATH_TAKEN_VAR]);

// ── Helpers ─────────────────────────────────────────────────────────────────

export function defaultExtractEquation(varName: string): ExtractEquation[] {
  return [
    { left: `{{${varName}}}`, operator: "exists" },
    { left: `{{${varName}}}`, operator: "!=", right: NOT_MENTIONED },
  ];
}

// ── Built-in Data Point Registry ─────────────────────────────────────────────

export const DATA_POINT_REGISTRY: Record<string, DataPoint> = {
  full_name: {
    label: "Full Name",
    variableName: "full_name",
    type: "string",
    choices: [],
    description: `Full name of the caller. If the caller does not specifically mention their name, set to "Not Mentioned". If the caller explicitly says they don't know the name, set to "Caller Doesn't Know".`,
    conversationPrompt: `Your goal is to collect the caller's full name by asking: "Can I get your name please?"

Do not assume the caller's name from caller ID or any other source. Always ask.

If the caller is correcting your spelling, correct the spelling and re-confirm.

If the caller says they don't know or aren't sure of the name, acknowledge it and move on.`,
    forwardCondition: "The caller has given you their name or has indicated they don't know it",
    finetuneExamples: [
      {
        type: "negative",
        transcript: [
          { content: "It's John.", role: "user" },
          { content: "Got it, and your last name?", role: "agent" },
        ],
      },
    ],
    extractSuccessEquation: defaultExtractEquation("full_name"),
  },
  phone_number: {
    label: "Phone Number",
    variableName: "phone_number",
    type: "string",
    choices: [],
    description: `Phone number of the caller. Convert any spoken digits to numeric format (e.g., 'three one two five five five one two three four' becomes '312-555-1234'). If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the phone number, set to "Caller Doesn't Know".`,
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

If the caller says they don't know the number, acknowledge it and move on.
    `,
    forwardCondition: "You have the caller's best number to reach them, or the caller has indicated they don't know it.",
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
    extractSuccessEquation: defaultExtractEquation("phone_number"),
  },
  email: {
    label: "Email",
    variableName: "email",
    type: "string",
    choices: [],
    description: `Email address of the caller. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the email, set to "Caller Doesn't Know".`,
    conversationPrompt: `Ask the caller for their email address.

Spell it back to confirm you have it right.

If the caller says they don't know their email address, acknowledge it and move on.`,
    forwardCondition: "The caller has given you their email address or has indicated they don't know it",
    extractSuccessEquation: defaultExtractEquation("email"),
  },
  street_address: {
    label: "Street Address",
    variableName: "street_address",
    type: "string",
    choices: [],
    description: `The physical street address. Extract only the street number and street name (e.g., "123 Main Street"). Do not include city, state, or zip code. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the address, set to "Caller Doesn't Know".`,
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

If the caller says they don't know the address, acknowledge it and move on.

##
Do not ask for any other information than what is instructed for this node.`,
    forwardCondition: "You have confirmed the caller's street address, or the caller has indicated they don't know it.",
    extractSuccessEquation: defaultExtractEquation("street_address"),
  },
  city: {
    label: "City",
    variableName: "city",
    type: "string",
    choices: [],
    description: `The city of the property. Extract only the city name (e.g., "Los Angeles"). Do not include state or zip code. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the city, set to "Caller Doesn't Know".`,
    conversationPrompt: `Ask the caller for their city by saying "Which city are you in?"

Refer to the system prompt for list of cities we service.

If the caller says they don't know the city, acknowledge it and move on.

##
Do not ask for any other information than what is instructed for this node.`,
    forwardCondition: "The caller has given you their city or has indicated they don't know it",
    extractSuccessEquation: defaultExtractEquation("city"),
  },
  company_name: {
    label: "Company Name",
    variableName: "company_name",
    type: "string",
    choices: [],
    description: `The name of the caller's company or business. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the company name, set to "Caller Doesn't Know".`,
    conversationPrompt: `Ask the caller for their company or business name by asking: "May I get the company name?"

If the caller says they don't know the company name, acknowledge it and move on.`,
    forwardCondition: "The caller has given you their company name or has indicated they don't know it",
    extractSuccessEquation: defaultExtractEquation("company_name"),
  },
  // ── Trucking ─────────────────────────────────────────────────────────────────
  truck_number: {
    label: "Truck Number",
    variableName: "truck_number",
    type: "string",
    choices: [],
    description: `The fleet vehicle identifier (e.g., "Truck 124", "Unit 87"). If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the truck number, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect the truck number by asking:\n\n"what is the truck number?"\n\nIf the caller says they don't know the truck number, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the truck number or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("truck_number"),
  },
  driver_name: {
    label: "Driver Name",
    variableName: "driver_name",
    type: "string",
    choices: [],
    description: `The name of the driver who is with the vehicle. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the driver's name, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect the name of the driver who is with the truck by asking:\n\n"what is the driver's name?"\n\nIf the caller says they don't know the driver's name, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the driver's name or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("driver_name"),
  },
  driver_phone: {
    label: "Driver Phone Number",
    variableName: "driver_phone",
    type: "string",
    choices: [],
    description: `The phone number where the driver can be reached directly. Convert any spoken digits to numeric format (e.g., 'three one two five five five one two three four' becomes '312-555-1234'). If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the driver's phone number, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect the driver's direct phone number by asking:\n\n"what is the driver's phone number?"\n\nIf the caller gives you an incomplete phone number, ask for it again.\n\nPhone Number Readback Rules:\nFormat\n\t•\tRead phone numbers in three sections:\n\t•\tArea code\n\t•\tPrefix\n\t•\tLine number\n\nExample\n\t•\tCaller says: 214-555-1234\n\t•\tRead back as:\n"Two one four… five five five… one two three four."\n\n\t•\tDigits are read individually, never as full numbers.\n\t•\tInsert a ~475–550 ms pause between each section.\n\t•\tDo not add country codes unless the caller explicitly states one.\n\nPacing\n\t•\tTarget speed: 2.5–3.2 characters per second\n\t•\tThis is slower than conversational speech but still natural.\n\nIf the caller says they don't know the driver's phone number, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the driver's complete 10 or more digit phone number, or has indicated they don't know it",
    finetuneExamples: [
      {
        type: "negative",
        transcript: [
          {
            content: "Driver's Direct's phone number is eight six seven five three zero nine.",
            role: "user",
          },
          {
            content: "I'm sorry, I don't think I heard the complete phone number.",
            role: "agent",
          },
        ],
      },
    ],
    extractSuccessEquation: defaultExtractEquation("driver_phone"),
  },
  breakdown_location: {
    label: "Breakdown Location",
    variableName: "breakdown_location",
    type: "string",
    choices: [],
    description: `Where the truck is broken down. This could be a truck stop name, highway and mile marker, city, cross streets, or any description the caller provides. Capture as much detail as given. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the location, set to "Caller Doesn't Know".`,
    conversationPrompt: `Ask the caller where the truck is located by saying "Where is the vehicle located?"

Do not elaborate on your initial question.

After they respond, determine if you have enough detail to find the truck:

If they give a highway (like I-80, I-55, Route 6):
- You also need a mile marker OR a nearby city/town/exit. Ask: "Do you have a mile marker or what's the nearest city or exit?"

If they give a truck stop or business name (like Pilot, TA, Love's):
- That's sufficient. Move on.

If they give a city or town only:
- You need a street address or cross streets or a landmark. Ask: "Do you have a street address or cross streets?"

If they give a full street address:
- That's sufficient. Move on.

A complete location is one of these:
- Highway + mile marker (e.g., "I-80 eastbound, mile marker 118")
- Highway + nearby city (e.g., "I-55 south, near Gardner")
- Truck stop or business name + city (e.g., "Pilot in Morris")
- Street address (e.g., "4500 Industrial Dr")

Do not move on until you have enough detail for a technician to find the truck.

Do not repeat the full location back to them.

If the caller says they don't know the location, acknowledge it and move on.`,
    forwardCondition: "The caller has described to you the location of the truck or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("breakdown_location"),
  },
  problem_description: {
    label: "Problem Description",
    variableName: "problem_description",
    type: "string",
    choices: [],
    description: `A description of what is wrong with the truck (e.g., won't start, clicking noise, overheating, flat tire, alternator issue). Capture the caller's description in their own words. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know what's wrong, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect the truck problem by asking:\n\n"what is going wrong with the truck?"\n\nIf the caller says they don't know what's wrong with the truck, acknowledge it and move on.`,
    forwardCondition: "The caller has described the problem with the truck or has indicated they don't know what's wrong",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("problem_description"),
  },
  vehicle_type: {
    label: "Vehicle Type",
    variableName: "vehicle_type",
    type: "enum",
    choices: [
      "Semi tractor-trailer",
      "Box truck",
      "Dump truck",
      CALLER_DOESNT_KNOW,
      "Other",
      NOT_MENTIONED,
    ],
    description: `The type of vehicle that needs service. If the caller says something not in the list, set to "Other". If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the vehicle type, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect the truck vehicle type by asking:\n\n"what type of truck is it?"\n\nDo not give examples unless they are unsure, then you can provide them up to three examples.\n\nIf the caller says they don't know the vehicle type, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the vehicle type or has indicated they don't know it.",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("vehicle_type"),
  },
  vehicle_manufacturer: {
    label: "Vehicle Manufacturer",
    variableName: "vehicle_manufacturer",
    type: "enum",
    choices: [
      "Kenworth",
      "Peterbilt",
      "Freightliner",
      "International",
      "Volvo",
      "Mack",
      "Western Star",
      "Hino",
      "Isuzu",
      CALLER_DOESNT_KNOW,
      "Other",
      NOT_MENTIONED,
    ],
    description: `The make or manufacturer of the vehicle. If the caller says a brand not in the list, set to "Other". If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the make, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect the truck make by asking:\n\n"what make is the truck?"\n\nDo not give examples unless they are unsure, then you can provide them up to three examples.\n\nIf the caller says they don't know the make of the truck, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the make of the truck or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("vehicle_manufacturer"),
  },
  vehicle_color: {
    label: "Vehicle Color",
    variableName: "vehicle_color",
    type: "enum",
    choices: [
      "White",
      "Black",
      "Red",
      "Blue",
      "Yellow",
      "Green",
      "Silver",
      "Gray",
      "Orange",
      CALLER_DOESNT_KNOW,
      "Other",
      NOT_MENTIONED,
    ],
    description: `The color of the vehicle. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the color, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect the truck color by asking:\n\n"what color is the truck?"\n\nIf the caller says they don't know the color of the truck, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the color of the truck or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("vehicle_color"),
  },
  whos_paying: {
    label: "Who's Paying",
    variableName: "whos_paying",
    type: "string",
    choices: [],
    description: `Who is responsible for the bill for the service. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know who's paying, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect who will be responsible for the bill by asking:\n\n"who will be responsible for payment?"\n\nDo not give examples unless they are unsure, then you can provide them up to three examples.\n\nIf they say one word like "Me" or "Us" then just assume it is the caller's company and proceed.\n\nIf the caller says they don't know who will be paying, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated who is paying for the service or has indicated they don't know",
    finetuneExamples: [
      {
        type: "positive",
        transcript: [{ content: "Us", role: "user" }],
      },
      {
        type: "positive",
        transcript: [{ content: "Me", role: "user" }],
      },
      {
        type: "positive",
        transcript: [{ content: "The company", role: "user" }],
      },
      {
        type: "positive",
        transcript: [{ content: "We are", role: "user" }],
      },
    ],
    extractSuccessEquation: defaultExtractEquation("whos_paying"),
  },
  payment_method: {
    label: "Payment Method",
    variableName: "payment_method",
    type: "enum",
    choices: [
      "EFS",
      "Credit Card",
      "Comdata",
      "Fleet account",
      "Cash",
      "Check",
      CALLER_DOESNT_KNOW,
      "Other",
      NOT_MENTIONED,
    ],
    description: `The method of payment for the service. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know the payment method, set to "Caller Doesn't Know".`,
    conversationPrompt: `Collect what payment method they'll be using by asking:\n\n"what payment method will be used?"\n\nDo not give examples unless they are unsure, then you can provide them up to three examples.\n\nIf the caller repeats themselves twice, assume what they are saying is the payment method and transition.\n\nIf the caller says they don't know the payment method, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the payment method they will be using or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("payment_method"),
  },
  // ── Caller Info (new) ───────────────────────────────────────────────────────
  callback_number: {
    label: "Callback Number",
    variableName: "callback_number",
    type: "string",
    choices: [],
    description: `An alternate phone number where the caller can be reached. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't have one, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if there is another number they can be reached at by saying "Is there another number we can reach you at if needed?"\n\nIf they say no or that the current number is fine, acknowledge it and move on.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided an alternate number, indicated the current number is sufficient, or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("callback_number"),
  },
  existing_customer: {
    label: "Existing Customer",
    variableName: "existing_customer",
    type: "enum",
    choices: ["Yes", "No", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `Whether the caller is an existing customer or client. If they say yes, set to "Yes". If they say no or this is their first time, set to "No". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if they are an existing customer by saying "Have you worked with us before?"\n\nIf the caller says they don't know or aren't sure, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated whether they are an existing customer or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("existing_customer"),
  },
  caller_role: {
    label: "Caller Role",
    variableName: "caller_role",
    type: "string",
    choices: [],
    description: `The caller's relationship to the situation — e.g. homeowner, tenant, property manager, fleet dispatcher, office manager, family member. Capture in the caller's own words. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller about their role by saying "And are you the homeowner, or what is your role in this situation?"\n\nAdapt the question naturally based on context. If the caller says they don't know or it's not applicable, acknowledge it and move on.`,
    forwardCondition: "The caller has described their role or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("caller_role"),
  },
  // ── Location (new) ────────────────────────────────────────────────────────
  state: {
    label: "State",
    variableName: "state",
    type: "string",
    choices: [],
    description: `The state or province. Extract only the state name or abbreviation (e.g., "California" or "CA"). If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know the state, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller for their state by saying "Which state are you in?"\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has given you their state or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("state"),
  },
  zip_code: {
    label: "Zip Code",
    variableName: "zip_code",
    type: "string",
    choices: [],
    description: `The zip or postal code. Convert any spoken digits to numeric format. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know the zip code, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller for their zip code by saying "What is the zip code there?"\n\nIf the caller gives an incomplete zip code, ask them to repeat it.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided their zip code or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("zip_code"),
  },
  unit_number: {
    label: "Unit Number",
    variableName: "unit_number",
    type: "string",
    choices: [],
    description: `The apartment, suite, or unit number. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says there is no unit number, set to "N/A". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if there is an apartment or unit number by saying "Is there an apartment or unit number?"\n\nIf they say no, acknowledge it and move on.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided a unit number, indicated there is none, or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("unit_number"),
  },
  gate_code: {
    label: "Gate Code",
    variableName: "gate_code",
    type: "string",
    choices: [],
    description: `A gate code or access code needed to enter the property. If not mentioned, set to "${NOT_MENTIONED}". If the caller says there is no gate, set to "N/A". If the caller explicitly says they don't know the code, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if there is a gate code or access code needed by saying "Is there a gate code we'll need to get in?"\n\nIf they say no gate, acknowledge it and move on.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the gate code, indicated there is none, or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("gate_code"),
  },
  // ── Service Details (new) ──────────────────────────────────────────────────
  service_type: {
    label: "Service Type",
    variableName: "service_type",
    type: "string",
    choices: [],
    description: `The type of service the caller is requesting. Capture in the caller's own words (e.g., "AC repair", "leak under the sink", "lock change"). If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller what type of service they need by saying "What can we help you with today?"\n\nIf the caller says they don't know what service they need, acknowledge it and move on.`,
    forwardCondition: "The caller has described the service they need or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("service_type"),
  },
  issue_description: {
    label: "Issue Description",
    variableName: "issue_description",
    type: "string",
    choices: [],
    description: `A description of the problem or issue the caller is experiencing. Capture the caller's description in their own words. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know what's wrong, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller to describe the issue by saying "Can you describe what's going on?"\n\nLet them explain in their own words. If they give a very brief answer, ask one follow-up like "How long has this been happening?" or "Is there anything else you've noticed?"\n\nIf the caller says they don't know what's wrong, acknowledge it and move on.`,
    forwardCondition: "The caller has described the issue or has indicated they don't know what's wrong",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("issue_description"),
  },
  urgency_level: {
    label: "Urgency Level",
    variableName: "urgency_level",
    type: "enum",
    choices: ["Emergency", "Same Day", "Routine", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `How urgent the request is. If the caller describes an active emergency (flooding, gas leak, no heat in freezing weather, etc.), set to "Emergency". If they want someone today, set to "Same Day". If they're flexible on timing, set to "Routine". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they're not sure, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller about the urgency by saying "Is this an emergency, or is this something that can be scheduled?"\n\nIf they say it's an emergency, acknowledge the urgency.\n\nIf the caller says they don't know or aren't sure, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated the urgency level or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("urgency_level"),
  },
  special_instructions: {
    label: "Special Instructions",
    variableName: "special_instructions",
    type: "string",
    choices: [],
    description: `Any special instructions, notes, or access information from the caller. Capture in the caller's own words. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if there's anything else we should know by saying "Is there anything else we should know before we send someone out?"\n\nIf they say no, acknowledge it and move on.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided special instructions, indicated there are none, or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("special_instructions"),
  },
  how_did_you_hear: {
    label: "How Did You Hear About Us",
    variableName: "how_did_you_hear",
    type: "string",
    choices: [],
    description: `How the caller found out about the business (e.g., "Google", "a friend referred me", "Yelp", "drove by"). Capture in the caller's own words. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know or don't remember, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller how they heard about us by saying "By the way, how did you hear about us?"\n\nAccept whatever they say and move on. Don't press for details.\n\nIf the caller says they don't know or don't remember, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated how they heard about us or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("how_did_you_hear"),
  },
  // ── Property (new) ────────────────────────────────────────────────────────
  property_type: {
    label: "Property Type",
    variableName: "property_type",
    type: "enum",
    choices: ["Residential", "Commercial", "Industrial", "Multi-Family", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `The type of property. If the caller says something like "my house" or "my home," set to "Residential". If they mention an office, store, or business, set to "Commercial". If they mention a factory or warehouse, set to "Industrial". If they mention apartments or a duplex, set to "Multi-Family". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller about the property type by saying "Is this for a home, a business, or another type of property?"\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated the property type or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("property_type"),
  },
  number_of_stories: {
    label: "Number of Stories",
    variableName: "number_of_stories",
    type: "enum",
    choices: ["1", "2", "3+", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `How many stories the building has. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller how many stories the building is by saying "How many stories is the building?"\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated the number of stories or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("number_of_stories"),
  },
  year_built: {
    label: "Year Built",
    variableName: "year_built",
    type: "string",
    choices: [],
    description: `The approximate year the building was constructed. Accept approximate answers like "around 1990" or "the 80s". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller roughly when the building was built by saying "Do you know approximately when the building was built?"\n\nAccept rough estimates. If the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided an approximate year or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("year_built"),
  },
  has_pets: {
    label: "Pets on Site",
    variableName: "has_pets",
    type: "enum",
    choices: ["Yes", "No", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `Whether there are pets at the property. Important for technician safety and preparation. If the caller says yes, set to "Yes". If no pets, set to "No". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if there are any pets on the property by saying "Are there any pets at the property our technician should be aware of?"\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated whether there are pets or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("has_pets"),
  },
  // ── Home Services (new) ───────────────────────────────────────────────────
  equipment_brand: {
    label: "Equipment Brand",
    variableName: "equipment_brand",
    type: "string",
    choices: [],
    description: `The brand or manufacturer of the equipment that needs service (e.g., "Carrier", "Trane", "Rheem", "Lennox", "GE"). Capture what the caller says. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller for the brand of the equipment by saying "Do you know the brand or manufacturer of the unit?"\n\nIf the caller says they don't know the brand, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the equipment brand or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("equipment_brand"),
  },
  equipment_age: {
    label: "Equipment Age",
    variableName: "equipment_age",
    type: "string",
    choices: [],
    description: `The approximate age of the equipment in years (e.g., "about 10 years", "brand new", "pretty old"). Capture the caller's estimate. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller roughly how old the equipment is by saying "Do you know approximately how old the unit is?"\n\nAccept rough estimates. If the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the equipment age or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("equipment_age"),
  },
  warranty_status: {
    label: "Warranty Status",
    variableName: "warranty_status",
    type: "enum",
    choices: ["Yes", "No", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `Whether the equipment is currently under warranty. If the caller says it's under warranty, set to "Yes". If they say it's not or it expired, set to "No". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if the equipment is under warranty by saying "Is the unit still under warranty, do you know?"\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated the warranty status or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("warranty_status"),
  },
  // ── Legal Intake (new) ────────────────────────────────────────────────────
  case_type: {
    label: "Case Type",
    variableName: "case_type",
    type: "enum",
    choices: [
      "Personal Injury",
      "Family Law / Domestic Relations",
      "Criminal Defense",
      "Workers' Comp",
      "Civil Rights",
      "Immigration",
      "Estate Planning",
      CALLER_DOESNT_KNOW,
      "Other",
      NOT_MENTIONED,
    ],
    description: `The type of legal case the caller is inquiring about. If the caller describes a divorce, child custody, support, or property division matter, set to "Family Law / Domestic Relations". If it's a car accident or injury, set to "Personal Injury". Map to the closest category. If the caller describes something not in the list, set to "Other". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller what type of legal matter they are calling about by saying "Can you tell me a little about what your legal matter involves?"\n\nLet them explain in their own words, then categorize based on their response.\n\nIf the caller says they don't know or aren't sure what kind of case it is, acknowledge it and move on.`,
    forwardCondition: "The caller has described their legal matter or has indicated they don't know",
    finetuneExamples: [
      {
        type: "positive",
        transcript: [
          { content: "I need to file for divorce.", role: "user" },
        ],
      },
      {
        type: "positive",
        transcript: [
          { content: "I was in a car accident last week.", role: "user" },
        ],
      },
    ],
    extractSuccessEquation: defaultExtractEquation("case_type"),
  },
  opposing_party_name: {
    label: "Opposing Party Name",
    variableName: "opposing_party_name",
    type: "string",
    choices: [],
    description: `The full name of the opposing party in the legal matter. This is critical for conflict-of-interest checks. Capture the full name as spelled by the caller. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller for the name of the opposing party by saying "What is the name of the other party involved?"\n\nAfter they provide the name, ask them to spell it: "Could you spell that name for me, please?"\n\nIf the caller says they don't know the name of the opposing party, acknowledge it and move on.`,
    forwardCondition: "The caller has provided and spelled the opposing party's name, or has indicated they don't know it",
    finetuneExamples: [
      {
        type: "positive",
        transcript: [
          { content: "It's Johnson. J-O-H-N-S-O-N.", role: "user" },
        ],
      },
    ],
    extractSuccessEquation: defaultExtractEquation("opposing_party_name"),
  },
  case_jurisdiction: {
    label: "Case Jurisdiction",
    variableName: "case_jurisdiction",
    type: "string",
    choices: [],
    description: `The county or jurisdiction where the legal case is filed or where the matter is located (e.g., "Sacramento County", "Los Angeles County"). If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller where the case is located by saying "Which county is your case in?"\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the jurisdiction or has indicated they don't know it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("case_jurisdiction"),
  },
  incident_date: {
    label: "Incident Date",
    variableName: "incident_date",
    type: "string",
    choices: [],
    description: `When the incident or event occurred. Accept approximate dates like "last Tuesday", "about two weeks ago", "March 15th". Capture in the caller's own words. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller when the incident occurred by saying "When did this happen?"\n\nAccept approximate answers. If the caller says they don't know or can't remember, acknowledge it and move on.`,
    forwardCondition: "The caller has provided an approximate date or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("incident_date"),
  },
  incident_location: {
    label: "Incident Location",
    variableName: "incident_location",
    type: "string",
    choices: [],
    description: `Where the incident occurred — could be a city, intersection, address, or general area. Capture as much detail as the caller provides. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller where the incident occurred by saying "Where did this happen?"\n\nIf they give a general area, that's fine. Don't press for an exact address unless they can provide one.\n\nIf the caller says they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has described where the incident occurred or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("incident_location"),
  },
  injury_description: {
    label: "Injury Description",
    variableName: "injury_description",
    type: "string",
    choices: [],
    description: `A description of the injuries or damages sustained. Capture in the caller's own words (e.g., "broken arm", "back and neck pain", "totaled car"). If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they weren't injured, set to "No injuries reported". If the caller explicitly says they don't know the extent, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller to describe any injuries by saying "Were there any injuries involved?"\n\nLet them describe in their own words. Be sensitive — don't press for more detail than they're comfortable sharing.\n\nIf the caller says they weren't injured or they don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has described any injuries, indicated there were none, or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("injury_description"),
  },
  has_attorney: {
    label: "Has Attorney",
    variableName: "has_attorney",
    type: "enum",
    choices: ["Yes", "No", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `Whether the caller currently has or has had an attorney for this matter. If the caller says yes, set to "Yes". If they say no, set to "No". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they're not sure, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if they currently have an attorney by saying "Are you currently working with an attorney on this matter?"\n\nIf the caller says they don't know, they're not sure, or it's complicated, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated whether they have an attorney or has indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("has_attorney"),
  },
  medical_treatment: {
    label: "Medical Treatment",
    variableName: "medical_treatment",
    type: "enum",
    choices: ["Yes", "No", "Scheduled", "Not Applicable", CALLER_DOESNT_KNOW, NOT_MENTIONED],
    description: `Whether the caller has received or is receiving medical treatment related to the matter. If they've been to a doctor or hospital, set to "Yes". If they haven't sought treatment, set to "No". If they have an upcoming appointment, set to "Scheduled". If the matter doesn't involve injuries, set to "Not Applicable". If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they're not sure, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller if they've received medical treatment by saying "Have you seen a doctor or received any medical treatment for this?"\n\nIf the caller says they don't know, they're not sure, or it doesn't apply, acknowledge it and move on.`,
    forwardCondition: "The caller has indicated their medical treatment status, indicated it's not applicable, or indicated they don't know",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("medical_treatment"),
  },
  // ── Billing (new) ─────────────────────────────────────────────────────────
  insurance_provider: {
    label: "Insurance Provider",
    variableName: "insurance_provider",
    type: "string",
    choices: [],
    description: `The name of the caller's insurance company (e.g., "State Farm", "Allstate", "Blue Cross"). If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't have insurance or don't know, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller for their insurance provider by saying "Who is your insurance provider?"\n\nIf the caller says they don't have insurance or don't know, acknowledge it and move on.`,
    forwardCondition: "The caller has provided their insurance provider or has indicated they don't know or don't have one",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("insurance_provider"),
  },
  policy_number: {
    label: "Policy Number",
    variableName: "policy_number",
    type: "string",
    choices: [],
    description: `The insurance policy number or claim number. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't have it handy, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller for their policy or claim number by saying "Do you have your policy or claim number handy?"\n\nIf they don't know it or don't have it available, acknowledge it and move on.`,
    forwardCondition: "The caller has provided the policy number or has indicated they don't know or don't have it",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("policy_number"),
  },
  account_number: {
    label: "Account Number",
    variableName: "account_number",
    type: "string",
    choices: [],
    description: `The customer's account number, purchase order number, or reference number. If not mentioned, set to "${NOT_MENTIONED}". If the caller explicitly says they don't have it, set to "${CALLER_DOESNT_KNOW}".`,
    conversationPrompt: `Ask the caller for their account or reference number by saying "Do you have an account number or reference number?"\n\nIf they don't know it or don't have it, acknowledge it and move on.`,
    forwardCondition: "The caller has provided an account number or has indicated they don't know or don't have one",
    finetuneExamples: [],
    extractSuccessEquation: defaultExtractEquation("account_number"),
  },
  // ── Scheduling ──────────────────────────────────────────────────────────────
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
          CALLER_DOESNT_KNOW,
          NOT_MENTIONED,
        ],
        description: `The day the caller would like us to come out and see them. If they say "as soon as possible" or "right away" or "now," set to "the current day which is {{current_time_America/Los_Angeles}}." If they say or imply a specific day of the week, use that day. If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know what day works, set to "Caller Doesn't Know".`,
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
          CALLER_DOESNT_KNOW,
          NOT_MENTIONED,
        ],
        description: `The 2-hour time window the caller prefers. If the caller gives a specific time like "around 3," map to the closest window (2 PM - 4 PM). If they say "morning," use "8 AM - 10 AM." If they say "afternoon," use "12 PM - 2 PM." If they say "evening" or "later in the day," use "4 PM - 6 PM." If not mentioned, set to "Not Mentioned". If the caller explicitly says they don't know what time works, set to "Caller Doesn't Know".`,
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

If the caller says they don't know when they'd like someone to come out, or can't commit to a day or time, acknowledge it and move on.

##
Do not ask for any other information than what is instructed for this node.`,
    forwardCondition:
      "The caller has agreed to one of your day and time slot options, or has indicated they don't know when works.",
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
