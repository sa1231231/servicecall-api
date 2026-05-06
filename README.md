# ServiceCall Saver API

An Express API that dispatches service call notifications (SMS + email) after Retell AI agents handle inbound phone calls. Also integrates with GoHighLevel for calendar scheduling.

**Production URL:** `https://servicecall-api-production.up.railway.app`

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Notification Clients](#notification-clients)
- [Call-to-Notification Flow](#call-to-notification-flow)
- [API Endpoints](#api-endpoints)
- [Environment Variables](#environment-variables)
- [Development](#development)
- [Deployment](#deployment)

---

## Architecture Overview

```
Caller → Retell AI Agent → POST /retell/post-hook → SMS (Twilio) + Email (Resend)
```

1. A caller dials in and a Retell AI agent handles the call
2. When the call ends, Retell sends a webhook to `/retell/post-hook`
3. The API looks up the client config by `agent_id`
4. It builds a notification from the collected call data
5. It dispatches via SMS (Twilio) and email (Resend) to the client's dispatch contacts

### Project Structure

```
src/
├── index.ts                        # Express app entry point
├── config.ts                       # Environment variable loading
├── config/
│   └── notification-clients.ts     # Client definitions
├── lib/
│   ├── notify-sms.ts               # Twilio SMS dispatch
│   ├── notify-email.ts             # Resend email dispatch
│   ├── retry.ts                    # Exponential backoff retry
│   ├── escape-html.ts              # HTML escaping for emails
│   └── verify-retell.ts            # Retell webhook signature verification
└── routes/
    ├── health.ts                   # GET /health
    ├── retell/
    │   ├── pre-hook.ts             # POST /retell/pre-hook (call validation)
    │   └── post-hook.ts            # POST /retell/post-hook (notifications)
    └── deckscience/
        ├── get-slots.ts            # Calendar slot availability
        └── create-appointment.ts   # Create calendar appointment
```

---

## Notification Clients

Client records live in MongoDB and are loaded into an in-memory cache at startup (`src/config/client-store.ts` → `src/_cache/clients.ts`). Each client maps a Retell agent to dispatch contacts and message templates. The `notification-clients.ts` file holds the TypeScript shapes only; the data itself is DB-backed.

### Client Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name shown in notifications |
| `agent_ids` | string[] | Retell agent IDs linked to this client |
| `dispatch_numbers` | string[] | Phone numbers to receive SMS notifications |
| `dispatch_email` | string[] \| null | Email addresses for dispatch notifications |
| `dispatch_cc` | string \| null | CC email address |
| `resolve_type` | function | Determines message type from call variables |
| `message_types` | Record | Message templates keyed by type |
| `default_message_type` | string | Fallback message type |
| `phone_fallback_to_caller` | boolean | Use caller's number if phone not collected |
| `hide_not_mentioned` | boolean | Omit fields with value "Not Mentioned" |
| `shadow_mode` | boolean | Send dry-run preview to owner instead of dispatch |

### Message Types

Each message type defines a `label`, `subject_template`, optional `additional_text`, and a list of `fields` to include.

**Fields** can have:
- `required: true` — field must be non-empty and not "Not Mentioned", or the notification is blocked
- `required: { equals: "value" }` — field must match a specific value, or the notification is blocked
- `show: false` — field is used for validation/routing only and excluded from SMS/email output (defaults to `true`)
- `show_when` — conditional visibility based on another field's value
- `format: "yes_no"` — converts `"true"`/`"false"` to `"Yes"`/`"No"`

**Example: guardrail field** — blocks notification unless `is_dispatch` is `"true"`, but never appears in the message:
```typescript
{ key: "is_dispatch", label: "Dispatch", show: false, required: { equals: "true" } }
```

### Adding a New Client

Clients are created either through the dashboard UI or via `POST /agents/create`, which generates the Retell conversation flow + agent and persists the client record to MongoDB. The in-memory `agentIdToClient` lookup is rebuilt from the DB on every startup.

---

## Call-to-Notification Flow

```
1. Call ends → Retell sends POST /retell/post-hook

2. Verify signature (HMAC-SHA256)

3. Look up client by agent_id
   └─ agentIdToClient[call.agent_id]

4. Extract variables
   ├─ retell_llm_dynamic_variables (LLM-generated)
   └─ collected_dynamic_variables (from caller)

5. Resolve message type
   └─ client.resolve_type(allVars) → e.g., "emergency"

6. Check required fields
   └─ Block notification if any required field fails validation

7. Build notification
   ├─ Filter visible fields (show, show_when, hide_not_mentioned)
   ├─ Format values (yes_no)
   ├─ Build SMS (plain text)
   └─ Build email (plain text + HTML with escaped values)

8. Dispatch
   ├─ SMS → Twilio → each dispatch_number
   └─ Email → Resend → each dispatch_email

9. Monitor email delivery (fire-and-forget, 5s delay)
   └─ Alert if bounced/failed/delayed
```

### Example SMS Output

```
Hi Pro V, you have a new call!

EMERGENCY CALL

Name: John Smith
Phone: 619-555-1234
Address: 1252 Main Street
City: San Diego
Problem: Pipe burst under kitchen sink

Caller expects contact within 10 minutes.

— Service Call Saver
```

---

## API Endpoints

### `GET /health`
Health check. No auth required.

### `POST /retell/pre-hook`
Retell pre-call webhook. Validates inbound calls. Auth: Retell signature.

### `POST /retell/post-hook`
Retell post-call webhook. Dispatches notifications. Auth: Retell signature (skipped for test client).

### `POST /deckscience/get-slots`
Returns available calendar slots for the next 21 days. Auth: `X-API-Key` header.

### `POST /deckscience/create-appointment`
Creates a 90-minute appointment in GoHighLevel. Auth: `X-API-Key` header.

### Rate Limits
- Global: 300 requests / 15 minutes
- Retell webhooks: 60 requests / minute

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RETELL_SIGNATURE_KEY` | Yes | HMAC key for Retell webhook verification |
| `RETELL_API_KEY` | Yes | Retell SDK API key (used for agent creation + chat clones) |
| `API_KEY` | Yes | API key for protected routes (X-API-Key header) |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio account ID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio API token |
| `TWILIO_PHONE_NUMBER` | Yes | Outbound SMS number |
| `RESEND_API_KEY` | Yes | Resend email API key |
| `GHL_API_KEY` | Yes | GoHighLevel API key |
| `MONGODB_URL` | Yes | MongoDB connection string |
| `ROOT_PASSWORD` | Yes | Root account password (break-glass dashboard auth) |
| `PORT` | No | Server port (default: 3000) |
| `BASE_URL` | No | API base URL |
| `EMAIL_FROM` | No | Sender email (default: notifications@servicecallsaver.com) |
| `SYSTEM_TEST_URL` | No | Target URL for `npm run test:system` / `test:paths` (overrides `BASE_URL`) |
| `CI` | No | Set by CI; toggles Playwright retry/worker behavior in `playwright.config.ts` |

---

## Development

### Setup

```bash
npm install
cp .env.example .env  # Fill in secrets
```

### Run

```bash
npm run dev          # Development with live reload (tsx watch)
npm run build        # Compile TypeScript
npm start            # Run compiled app
```

### Test

```bash
npm test             # Run unit tests (vitest)
npm run test:watch   # Watch mode

# Integration tests (requires running server)
./tests/health.sh
./tests/notify.sh

# System tests (vitest, runs against a live URL)
npm run test:system  # Requires SYSTEM_TEST_URL, API_KEY, ROOT_PASSWORD env vars

# E2E browser tests (Playwright, runs against a live URL with Demo Meter)
# One-time setup: npx playwright install chromium
npm run test:e2e      # Headless
npm run test:e2e:ui   # Interactive Playwright UI for debugging
```

### Type Check

```bash
npm run typecheck
```

---

## Deployment

Deployed on **Railway** via Docker.

```dockerfile
# Multi-stage build: node:20-alpine
# 1. Builder: install deps + compile TypeScript
# 2. Runtime: copy dist + production deps only
# Exposes port 3000
```

Push to `main` to deploy.

---

## Security

- **Webhook signatures**: Retell (HMAC-SHA256) verification
- **HTML escaping**: All user-provided values escaped in email HTML
- **Rate limiting**: Global + per-route limits
- **API key auth**: Required on protected routes
- **Retry with backoff**: SMS and email sends retry up to 3 times
- **Email monitoring**: Delivery status checked after send, alerts on failures
