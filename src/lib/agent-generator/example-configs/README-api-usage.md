# POST /agents/create — API Usage

## Example: Create a Poop 911 agent

```bash
curl -X POST https://servicecall-api-production.up.railway.app/agents/create \
  -H "Content-Type: application/json" \
  -H "X-API-Key: 79f1616082049417d93eb32621a781e52b46690664ae4e0a67a538fcb0d8fb5b" \
  -d '{
  "business": {
    "businessName": "Poop 911",
    "faqKnowledgeBase": "## Company Overview\n- Business Name: POOP 911\n- Location: Charlotte, North Carolina\n- Type: Locally owned and operated franchise\n\n## Services Offered\n### Residential Pooper Scooper Service (Primary)\n- Recurring yard cleanup for homeowners with dogs\n- Available frequencies: weekly, twice weekly, or custom\n- First cleanup is FREE when you sign up for regular service\n- No contracts, no commitments, cancel anytime\n\n## Pricing\n- Weekly service starting at just $14.95 per visit\n- Final pricing depends on yard size, number of dogs, and frequency",
    "introFinetuneExamples": [
      {
        "type": "positive",
        "destination": "__faq__",
        "transcript": [
          { "content": "How much do you charge?", "role": "user" }
        ]
      },
      {
        "type": "positive",
        "destination": "__faq__",
        "transcript": [
          { "content": "What areas do you service?", "role": "user" }
        ]
      },
      {
        "type": "positive",
        "destination": "__extract__",
        "transcript": [
          { "content": "I need to schedule a pickup.", "role": "user" }
        ]
      },
      {
        "type": "positive",
        "destination": "__extract__",
        "transcript": [
          { "content": "Yeah I'd like to get a quote please.", "role": "user" }
        ]
      },
      {
        "type": "negative",
        "transcript": [
          { "content": "Who is this?", "role": "user" },
          { "content": "This is Anthony with Poop 911. How can I help you today?", "role": "agent" }
        ]
      },
      {
        "type": "negative",
        "transcript": [
          { "content": "Hey, good morning.", "role": "user" },
          { "content": "Good morning! How can I help you?", "role": "agent" }
        ]
      }
    ]
  },
  "dataPoints": [
    "full_name",
    "phone_number",
    "city",
    "street_address"
  ],
  "client": {
    "slug": "poop-911",
    "name": "Poop 911",
    "dispatch_text_numbers": ["+15551234567"],
    "dispatch_email": ["owner@poop911.com"],
    "shadow_mode": true
  }
}'
```

## Response

```json
{
  "success": true,
  "agent_id": "agent_abc123...",
  "conversation_flow_id": "cf_xyz789...",
  "notification_config": {
    "name": "Poop 911",
    "agent_ids": ["agent_abc123..."],
    "dispatch_text_numbers": ["+15551234567"],
    "dispatch_call_number": null,
    "summary_agent_id": null,
    "outbound_from_number": null,
    "dispatch_email": ["owner@poop911.com"],
    "dispatch_cc": null,
    "message_types": {
      "service_request": {
        "label": "New Service Request",
        "subject_template": "Service Request: {{full_name}} — {{street_address}}, {{city}}",
        "fields": [
          { "key": "full_name", "label": "Name" },
          { "key": "phone_number", "label": "Phone" },
          { "key": "city", "label": "City" },
          { "key": "street_address", "label": "Address" }
        ]
      }
    },
    "default_message_type": "service_request",
    "phone_fallback_to_caller": true,
    "hide_not_mentioned": false,
    "shadow_mode": true
  }
}
```

## Request Body Reference

### `business` (required)

| Field                   | Type   | Required | Description                                             |
| ----------------------- | ------ | -------- | ------------------------------------------------------- |
| `businessName`          | string | Yes      | The business name displayed in the agent's greeting     |
| `faqKnowledgeBase`      | string | Yes      | Markdown FAQ content the agent uses to answer questions |
| `introFinetuneExamples` | array  | Yes      | Training examples for the intro node (see below)        |

#### introFinetuneExamples

Each example has:

- `type`: `"positive"` (should transition out of intro) or `"negative"` (stay in intro)
- `destination` (positive only): `"__faq__"` (route to FAQ) or `"__extract__"` (start collecting info)
- `transcript`: array of `{ content, role }` objects

### `dataPoints` (required)

Array of built-in data point keys and/or custom data point objects.

**Built-in keys:** `"full_name"`, `"phone_number"`, `"email"`, `"street_address"`, `"city"`, `"company_name"`, `"scheduling"`

**Custom data point object:**

```json
{
  "variableName": "number_of_dogs",
  "label": "Number of Dogs",
  "type": "string",
  "description": "How many dogs the caller has. If not mentioned, set to \"Not Mentioned\".",
  "conversationPrompt": "How many dogs do you have?",
  "forwardCondition": "The caller has provided the number of dogs.",
  "finetuneExamples": [
    {
      "type": "positive",
      "transcript": [{ "content": "I have 3 dogs.", "role": "user" }]
    },
    {
      "type": "negative",
      "transcript": [
        { "content": "A lot.", "role": "user" },
        {
          "content": "Do you have a rough count — like 2, 5, 10?",
          "role": "agent"
        }
      ]
    }
  ],
  "extractSuccessEquation": [
    { "left": "{{number_of_dogs}}", "operator": "exists" },
    { "left": "{{number_of_dogs}}", "operator": "!=", "right": "Not Mentioned" }
  ]
}
```

### `client` (required)

| Field                      | Type     | Required | Default | Description                                                  |
| -------------------------- | -------- | -------- | ------- | ------------------------------------------------------------ |
| `slug`                     | string   | Yes      | —       | Unique client identifier (e.g. `"poop-911"`)                 |
| `name`                     | string   | No       | slug    | Display name                                                 |
| `dispatch_text_numbers`    | string[] | Yes      | —       | SMS recipient phone numbers                                  |
| `dispatch_call_number`     | string   | No       | null    | Phone number for outbound dispatch call                      |
| `dispatch_email`           | string[] | No       | null    | Email recipient addresses                                    |
| `dispatch_cc`              | string   | No       | null    | CC email address                                             |
| `outbound_from_number`     | string   | No       | null    | Caller ID for outbound calls                                 |
| `summary_agent_id`         | string   | No       | null    | Retell agent ID for outbound call summaries                  |
| `phone_fallback_to_caller` | boolean  | No       | true    | Fall back to caller's number if phone_number not collected   |
| `hide_not_mentioned`       | boolean  | No       | false   | Filter out "Not Mentioned" values from notifications         |
| `shadow_mode`              | boolean  | No       | true    | Send dispatch previews to owner instead of actual recipients |

## Error Responses

| Status | Condition                    |
| ------ | ---------------------------- |
| 400    | Missing required fields      |
| 401    | Invalid or missing X-API-Key |
| 409    | Client slug already exists   |
| 502    | Retell API call failed       |
