# ServiceCall Saver API

Control plane for an AI phone-agent service. Operators design, deploy, monitor, and bill Retell-powered voice agents from a web dashboard; the API drives Retell + Twilio + MongoDB underneath. Inbound calls dispatch SMS/email notifications to the operator's customers; calendar booking, lead intake, and customer self-service portal are also handled here.

**Production URL:** `https://servicecall-api-production.up.railway.app`

---

## Table of Contents

- [What the App Does](#what-the-app-does)
- [Architecture Overview](#architecture-overview)
- [Auth Model](#auth-model)
- [Major Subsystems](#major-subsystems)
- [API Endpoints](#api-endpoints)
- [Background Jobs](#background-jobs)
- [Data Model](#data-model)
- [External Integrations](#external-integrations)
- [Environment Variables](#environment-variables)
- [Development](#development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security](#security)

---

## What the App Does

For each operator-managed client (a small service business — HVAC, plumbing, etc.), the system:

1. **Builds a Retell conversation-flow agent** from a template or operator-edited form, provisions a Twilio phone number, and routes inbound calls through it.
2. **Dispatches every completed call** as SMS + email to the client's contact list, with per-path overrides (e.g. emergency vs. quote calls go to different phones).
3. **Lets the operator edit the conversation flow** in a node editor — global prompt, intro/FAQ/close text, per-path data points, branches, transitions — with versioning and one-click rollback.
4. **Auto-syncs** Retell-side edits back into MongoDB every 3 minutes, snapshotting drift.
5. **Ingests leads** from a Google Sheet (Apps Script), enriches them via Anthropic web_search/web_fetch + Google Places + Brave Search + Yelp, and lets the operator promote any lead into a real agent in one click.
6. **Exposes a self-serve portal** so each client can review call history and update their own dispatch routing without involving the operator.
7. **Sends scheduled weekly reports**, SMS blasts, review-request links, payment links, and instructions templates from the dashboard.

---

## Architecture Overview

```
┌──────────────┐   inbound call    ┌─────────────────┐
│  PSTN caller │ ────────────────▶ │ Twilio number   │
└──────────────┘                   │ (BYOC trunk)    │
                                   └────────┬────────┘
                                            ▼
                                   ┌─────────────────┐
                                   │ Retell agent    │
                                   │ (conv-flow)     │
                                   └────────┬────────┘
                            pre-hook │      │ post-hook
                                     ▼      ▼
                          ┌────────────────────────────┐
                          │  servicecall-api (Express) │
                          │  ────────────────────────  │
                          │  • Dispatch SMS / email    │
                          │  • Persist call log        │
                          │  • Audit, versioning       │
                          │  • Auto-sync, schedules    │
                          └──────┬───────────┬─────────┘
                                 │           │
                                 ▼           ▼
                          ┌──────────┐  ┌────────────┐
                          │ MongoDB  │  │ Twilio SMS │
                          │ (canon)  │  │ Resend     │
                          └──────────┘  └────────────┘

┌────────────────────────┐    ┌────────────────────────┐
│ Operator dashboard     │    │ Customer portal        │
│ (browser, Basic auth)  │    │ (browser, magic link)  │
└─────────┬──────────────┘    └─────────┬──────────────┘
          ▼                             ▼
   /dashboard/api/*               /portal/:slug/api/*
```

### Project Structure

```
src/
├── index.ts                       # Express bootstrap, auth middleware, route mounts
├── config.ts                      # Required + optional env vars
├── _cache/                        # In-memory client cache (rebuilt from Mongo on boot)
├── config/
│   ├── client-store.ts            # CRUD for client docs, portal-token + email lookup
│   └── notification-clients.ts    # Owner-of-record dispatch config + ClientInfo type
├── middleware/
│   ├── require-role.ts            # requireFeature(feature, level) — feature-level RBAC
│   ├── require-service-token.ts   # Bearer-token check for headless intake
│   └── ...
├── lib/                           # ~50 modules — business logic + integrations
│   ├── agent-generator/           # Build canonical-JSON Retell agents from data points
│   ├── node-parser.ts             # Canonical JSON → ParsedFlow (paths, data chains)
│   ├── node-validator.ts          # Validate canonical JSON before Retell push
│   ├── node-regenerator.ts        # Apply node-editor edits to a ParsedPath
│   ├── retell-sync.ts             # Push/pull canonical JSON ↔ Retell SDK
│   ├── retell-auto-sync.ts        # 3-min interval sync + drift detection
│   ├── agent-versions.ts          # Version snapshots in agent_versions collection
│   ├── enrich-lead.ts             # Anthropic web_search/web_fetch lead enrichment
│   ├── pending-leads.ts           # Lead CRUD + status state machine
│   ├── notify-sms.ts              # Twilio SMS dispatch + retry
│   ├── notify-email.ts            # Resend dispatch + delivery monitoring
│   ├── dispatch-call.ts           # Outbound voice dispatch
│   ├── resolve-dispatch.ts        # Per-path → client-default dispatch resolver
│   ├── build-notification.ts      # Format SMS + HTML email from collected vars
│   ├── provision-number.ts        # Twilio buy + Retell BYOC link
│   ├── feature-permissions.ts     # Feature catalog + role defaults + level resolution
│   ├── role-defaults.ts           # Cache of per-role default permission maps
│   ├── audit.ts                   # logAudit() → audit_log collection
│   ├── backup.ts                  # R2/S3 export/restore of canonical configs
│   ├── weekly-report.ts           # Scheduled per-client weekly summary
│   ├── retell-chat-driver.ts      # Test-only Retell chat-mode driver
│   └── ...
├── routes/
│   ├── health.ts
│   ├── retell/                    # /retell pre-hook, post-hook, send-sms (HMAC-verified)
│   ├── agents/                    # /agents/* — machine routes (X-API-Key)
│   ├── dashboard/                 # /dashboard, /dashboard/api/* — sessionAuth
│   ├── leads/                     # /api/leads/* — sessionAuth + /intake bearer
│   ├── reports/                   # /api/reports — sessionAuth
│   ├── portal/                    # /portal/:slug/* — portal-token auth
│   ├── deckscience/               # /deckscience/* — calendar booking via GHL
│   └── qa.ts                      # /qa — operator-driven smoke runs
├── __tests__/                     # System tests against deployed Railway
└── types/
public/                            # Dashboard, form, portal, client-login HTML/JS bundles
tests/
├── e2e/                           # Playwright (one spec per feature surface)
└── live-api/                      # Vitest tests that hit deployed API + provision real Twilio numbers
```

---

## Auth Model

The API has **five distinct auth modes**; each route is mounted under exactly one:

| Mode | Used by | How |
|---|---|---|
| **None** | `/health`, `/portal/:slug` (HTML shell), `/client` (login page), `/portal/request-link` | Public |
| **Session (Basic auth → cookie)** | `/dashboard/*`, `/form`, `/quick-create`, `/api/backup`, `/qa`, `/api/leads`, `/api/reports` | Initial Basic auth checks DB user (`users` collection) or falls back to `ROOT_PASSWORD`. On success, sets an HMAC-signed `scs_session` cookie (14 d). Session secret is `SESSION_SECRET`, kept separate from `ROOT_PASSWORD`. Lockout: 5 failed logins / 15 min → 15 min freeze per username. |
| **Service token (Bearer)** | `/api/leads/intake` | `Authorization: Bearer <LEAD_INTAKE_TOKEN>` — for the Apps Script lead sync only. Mounted before `sessionAuth` on the parent path. |
| **API key** | `/agents/*`, `/deckscience/*` | `x-api-key: <API_KEY>` — for Retell tools, Apps Script, and machine callers. Constant-time compared. |
| **Portal token** | `/portal/:slug/api/*` | `Authorization: Bearer <portal-token>` (preferred) or `?token=` query (legacy magic links). Token is bound to a single client slug; cross-tenant use returns 401. |
| **Retell HMAC** | `/retell/pre-hook`, `/retell/post-hook`, `/retell/send-sms` | `x-retell-signature` SHA-256 HMAC over the raw body using `RETELL_SIGNATURE_KEY`. Internal calls can substitute `x-api-key` to skip the HMAC check (used by tests and synthetic events). |

Permission gates within the dashboard are enforced by `requireFeature(feature, level)`. Levels: `none` < `read` < `write` < `manage` < `full`. Defaults per role (`super_admin`, `admin`, `operator`, `viewer`) live in MongoDB (`role_defaults` collection) and override per user via `users.permissions`. Catalog lives in `src/lib/permission-catalog.ts`.

---

## Major Subsystems

### 1. Agent lifecycle (`src/routes/agents/`, `src/lib/agent-generator/`)

Agents are designed in the dashboard (form + drafts) and persisted as **canonical JSON** in MongoDB. The canonical JSON is the single source of truth — it gets pushed to Retell on publish and pulled back on auto-sync. Routes:

- `POST /agents/create` — full canonical JSON in → Retell agent + flow created → MongoDB persisted
- `POST /agents/from-draft` — apply `business`/`client` overrides on a saved draft, then create
- `POST /agents/import` — pull an existing Retell agent into MongoDB
- `POST /agents/:slug/sync` — pull latest from Retell into MongoDB (idempotent)
- `POST /agents/duplicate` — copy an existing agent under a new slug + name
- `POST /agents/provision-number` — buy a Twilio number, attach as Retell BYOC inbound + outbound
- `GET  /agents/:slug/export` — export canonical JSON for backup or migration

### 2. Node editor (`src/routes/dashboard/node-editor.ts`)

Pull–edit–push cycle with versioning. The dashboard fetches the parsed structure, the operator edits a single facet, and the API regenerates + validates + pushes the new canonical JSON to Retell, snapshotting the prior state in `agent_versions`.

- `GET    /dashboard/api/agents/:slug/nodes/:agentId` — parsed tree (paths, branches, data points, prompts)
- `GET    /dashboard/api/agents/:slug/nodes/:agentId/versions` — version history (last 50, 90-day TTL)
- `GET    /dashboard/api/agents/:slug/nodes/:agentId/versions/:versionId` — full snapshot
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-prompt` — single node prompt
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-global-prompt`
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-transition` — change `transition_condition`
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-branch-condition`
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-path-name`
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-path-end-mode` — callback ↔ transfer
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-human-request-mode`
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/edit-agent-settings` — allowlisted settings only
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/save-and-publish` — bulk path edit + publish
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/rollback` — restore a prior version
- `POST   /dashboard/api/agents/:slug/nodes/:agentId/push` — raw canonical-JSON push (debug)

### 3. Lead intake + enrichment (`src/routes/leads/`, `src/lib/enrich-lead.ts`)

Pipeline: **Apps Script → POST /api/leads/intake → Mongo (queued) → background enrichment → ready/failed → operator promote → real agent.** Enrichment runs an Anthropic skill (`skills/onboarding-to-config/`) with `web_search` + `web_fetch` tool use, augmented by Google Places, Brave Search (if configured), and Yelp pre-searches.

- `POST   /api/leads/intake` — bearer-token, idempotent on `externalId`, dedup-aware
- `GET    /api/leads` — list (default excludes terminal statuses)
- `GET    /api/leads/:id`
- `PATCH  /api/leads/:id` — operator edits to `input` / `enriched` / `status` / `externalId`
- `POST   /api/leads/:id/re-enrich` — re-run enrichment (e.g. after operator added a website)
- `POST   /api/leads/:id/dismiss` — soft-close
- `POST   /api/leads/:id/promote` — turn enriched lead into a Retell agent via `from-draft`

Settings toggle `lead_intake_enabled` flips the headless intake to `423 Locked` without affecting the in-dashboard `+ Add Lead` flow.

### 4. Dashboard (`src/routes/dashboard/`)

The operator-facing surface. ~50 routes covering agent CRUD, folders, audit log, settings, users, role defaults, data-point defaults, billing COGS, communications, blast SMS, deleted-agents restore. UI is served from `public/dashboard.html` + JS modules.

### 5. Customer portal (`src/routes/portal/`)

Per-client self-service. Magic-link flow (`POST /portal/request-link` → email with token → `/portal/:slug?token=...`), token bound to one slug. Customers can review call history and update their own dispatch routing without involving the operator.

- `GET  /portal/:slug` — HTML shell (no auth — token validates on API calls)
- `GET  /portal/:slug/api/agent` — filtered config for the bound client
- `GET  /portal/:slug/api/calls` — call log (web/test calls excluded)
- `PATCH /portal/:slug/api/settings` — allowlisted dispatch fields only
- `POST /portal/request-link` — magic link send (constant-time response to prevent enumeration)

### 6. Retell webhooks (`src/routes/retell/`)

- `POST /retell/pre-hook` — pre-call validation (returns dynamic vars if any)
- `POST /retell/post-hook` — post-call dispatch fan-out (SMS + email + call log)
- `POST /retell/send-sms` — agent-driven mid-call outbound SMS

### 7. DeckScience calendar (`src/routes/deckscience/`)

Thin wrapper around GoHighLevel (LeadConnector) for booking on-site consultations from inside a call. API-key authenticated.

- `POST /deckscience/get-slots` — 21-day availability window
- `POST /deckscience/create-appointment` — 90-min booking, accepts both raw body and Retell event_message

---

## API Endpoints

See [Major Subsystems](#major-subsystems) above for the per-domain breakdown. Cross-cutting:

### Public

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness probe |
| GET | `/client` | Login HTML for portal users |

### Rate limits

- **Global:** 300 req / 15 min per IP (proxy-aware)
- **Webhooks (`/retell/*`):** 60 req / min per IP
- **Auth-gated form:** stricter `authLimiter` — protects against credential stuffing
- **Portal (`/portal/*`):** 60 req / 15 min — protects against token brute-force

---

## Background Jobs

Both run from `app.listen` callback in `src/index.ts`:

| Job | File | Cadence | What it does |
|---|---|---|---|
| Retell auto-sync | `src/lib/retell-auto-sync.ts` | every 3 min | Pulls every active client's Retell agent into MongoDB. Skips clients deployed in the last 10 min (avoids racing publish). Snapshots a `source: "auto_sync"` row in `agent_versions` when canonical JSON drifts from what's stored — the dashboard surfaces this as "Drift detected". |
| Weekly report scheduler | `src/lib/weekly-report.ts` | scheduled | Sends per-client weekly call summaries. Manual trigger: `POST /api/reports/weekly?client_id=...`. |

Plus boot-time housekeeping: `purgeExpiredClients()`, `resetStaleEnrichingLeads()` (resets leads stuck in `enriching` status from a previous crashed run), `ensureAuditIndex`, `ensureVersionIndexes`, `ensurePendingLeadIndexes`.

---

## Data Model

Primary MongoDB collections:

| Collection | Shape | Notes |
|---|---|---|
| `clients` | `{ _id: slug, name, agent_id, retell_agents: { [agentId]: canonicalJson }, dispatch_text_numbers, dispatch_email, dispatch_call_number, dispatch_by_type, dispatch_cc, outbound_from_number, summary_agent_id, hide_not_mentioned, shadow_mode, active, last_deployed_at, contact_*, portal_token, ... }` | One doc per client. `_id` is the slug. |
| `agent_versions` | `{ slug, agentId, version, canonicalJson, source, description, createdBy, createdAt, nodeCount, dataPointCount }` | Version snapshots. TTL 90 d, max 50 per agent. |
| `pending_leads` | `{ _id, source, externalId?, status, input: {name, phone, website, notes, business_type}, enriched: {business_name, faqKnowledgeBase, templateName, extra}, enrichmentError?, createdAt, updatedAt }` | Status state machine: `queued → enriching → ready / failed → promoted / dismissed`. |
| `users` | `{ _id: username, password_hash, role, permissions, featurePermissions }` | Role + per-feature overrides. `sam_admin` is super-admin. |
| `role_defaults` | `{ _id: role, featurePermissions }` | Default feature/level map per role. Cached at boot. |
| `data_point_defaults` | `{ _id: key, label, type, choices?, conversationPrompt, forwardCondition, category, position, ... }` | Operator-curated catalog of available data points. |
| `audit_log` | `{ ts, user, action, target, details }` | Indexed, capped via TTL on `ts`. |
| `call_logs` | `{ slug, callId, agent_id, transcript, collected_dynamic_variables, retell_llm_dynamic_variables, call_cost_cents, duration_ms, ... }` | One row per Retell post-hook event. |
| `phone_history` | `{ slug, phone_number, sid, event, ts }` | Provisioned / released events. |
| `folders` | `{ _id, name, position, parent_id? }` | Dashboard-visible agent folders. |
| `drafts` | `{ name, formData, exportConfig, createdAt }` | Saved agent forms (used by `from-draft` and quick-create). |

The **canonical JSON** for a Retell agent has the shape `{ agent: {...}, conversationFlow: { start_node_id, global_prompt, nodes: [...], begin_tag_display_position, ... } }`. `node-parser.ts` derives a structured `ParsedFlow` (paths, data chains, branches, transitions) from it; `node-regenerator.ts` writes edits back into it; `node-validator.ts` blocks publish when the result is invalid.

---

## External Integrations

| Service | Purpose | Key env |
|---|---|---|
| **Retell SDK** | Agent CRUD, webhooks, chat clones (testing) | `RETELL_API_KEY`, `RETELL_SIGNATURE_KEY` |
| **Twilio** | Number provisioning, SMS dispatch, BYOC voice trunk | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_TRUNK_SID`, `TWILIO_EMERGENCY_ADDRESS_SID`, `TWILIO_MESSAGING_SERVICE_SID`, `RETELL_SIP_TRUNK_AUTH_USERNAME`, `RETELL_SIP_TRUNK_AUTH_PASSWORD` |
| **Resend** | Transactional email + portal magic links + delivery monitoring | `RESEND_API_KEY`, `EMAIL_FROM` |
| **MongoDB** | All persistent state | `MONGODB_URL` |
| **Anthropic** | Lead enrichment (web_search + web_fetch tool use) | `ANTHROPIC_API_KEY` |
| **Google Places (New)** | Phone-number-to-business resolution | `GOOGLE_PLACES_API_KEY` |
| **Brave Search** | Long-tail web context (Yelp, Nextdoor, BBB) for enrichment | `BRAVE_API_KEY` |
| **Yelp Fusion** | Phone reverse-lookup for service businesses | `YELP_API_KEY` |
| **GoHighLevel (LeadConnector)** | Calendar slot lookup + appointment creation | `GHL_API_KEY` |
| **Cloudflare R2 / S3** | Canonical JSON backups | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` |
| **Google Apps Script** | Lead intake from operator's Sheet | `LEAD_INTAKE_TOKEN` |

---

## Environment Variables

**Required at boot** (the app throws if missing):

| Variable | Description |
|---|---|
| `RETELL_SIGNATURE_KEY` | HMAC key for Retell webhook verification |
| `RETELL_API_KEY` | Retell SDK API key |
| `GHL_API_KEY` | GoHighLevel API key (DeckScience calendar) |
| `API_KEY` | Machine-route auth (`x-api-key` header) |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio API token |
| `TWILIO_PHONE_NUMBER` | Default outbound SMS sender |
| `RESEND_API_KEY` | Resend email API key |
| `MONGODB_URL` | MongoDB connection string |
| `ROOT_PASSWORD` | Break-glass dashboard auth |
| `SESSION_SECRET` | HMAC key for session cookies (independent of ROOT_PASSWORD) |
| `GOOGLE_PLACES_API_KEY` | Google Places (New) API key |

**Optional**:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `BASE_URL` | unset | API base URL (used by tests + portal links) |
| `EMAIL_FROM` | `notifications@servicecallsaver.com` | Sender address |
| `TWILIO_TRUNK_SID` | unset | BYOC outbound trunk SID |
| `TWILIO_EMERGENCY_ADDRESS_SID` | unset | E911 address SID for provisioning |
| `TWILIO_MESSAGING_SERVICE_SID` | unset | Messaging service for blast SMS |
| `RETELL_SIP_TRUNK_AUTH_USERNAME` | unset | Retell BYOC outbound trunk auth (digest) |
| `RETELL_SIP_TRUNK_AUTH_PASSWORD` | unset | Retell BYOC outbound trunk auth (digest) |
| `GOOGLE_REVIEW_URL` | unset | Default Google review URL for `/send-review` template |
| `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | unset | Cloudflare R2 (or S3) for canonical JSON backups |
| `R2_BUCKET` | `scs-mongo-backup` | Bucket name |
| `ANTHROPIC_API_KEY` | unset | Lead enrichment (when unset, leads land in `failed` status) |
| `BRAVE_API_KEY` | unset | Brave Search API for enrichment (long-tail web context) |
| `YELP_API_KEY` | unset | Yelp pre-search for enrichment |
| `LEAD_INTAKE_TOKEN` | unset | Apps Script lead-sync bearer token (when unset, headless intake returns 401 for everyone) |
| `SYSTEM_TEST_URL` | `BASE_URL` | Target for `npm run test:system*` |
| `CI` | unset | Set by CI; toggles Playwright retry/worker behavior |

---

## Development

### Setup

```bash
npm install
cp .env.example .env   # Fill in secrets — see required list above
```

### Run

```bash
npm run dev      # Live reload (tsx watch)
npm run build    # Compile TypeScript → dist/
npm start        # Run compiled app
npm run typecheck
```

### Apps Script (lead intake)

```bash
npm run apps-script:pull   # clasp pull
npm run apps-script:push   # clasp push
npm run apps-script:open   # open in browser
```

---

## Testing

Four distinct test surfaces. Vitest is the runner; CI runs only the unit suite.

### Unit (mocked, fast)

```bash
npm test               # vitest run — 1,600+ tests, all external services mocked
npm run test:watch
npm run coverage       # v8, thresholds: stmts 85, branches 75, fns 80, lines 85
npm run test:lint      # data-point-lint check, runs in pre-commit
```

Tests are colocated in `__tests__` folders next to source:
- `src/lib/__tests__/` — business logic
- `src/routes/<domain>/__tests__/` — handler tests
- `src/middleware/__tests__/` — auth gates
- `src/config/__tests__/` — client-store + notification-clients

### System (against deployed Railway)

Skip cleanly when env is missing — never accidentally fire in CI.

```bash
SYSTEM_TEST_URL=$BASE_URL API_KEY=... ROOT_PASSWORD=... \
  npm run test:system        # original system.test.ts (~150 cases)

SYSTEM_TEST_URL=$BASE_URL API_KEY=... ROOT_PASSWORD=... \
  RETELL_API_KEY=... npm run test:paths   # conversation-paths.test.ts (Retell chat-mode)

SYSTEM_TEST_URL=$BASE_URL API_KEY=... ROOT_PASSWORD=... LEAD_INTAKE_TOKEN=... \
  npm run test:system:all    # globs src/__tests__/system*.test.ts
```

Files:
- `src/__tests__/system.test.ts` — auth, dashboard CRUD, node editor, webhooks, intake
- `src/__tests__/conversation-paths.test.ts` — drives real Retell chat sessions through every path
- `src/__tests__/system-leads.test.ts` — lead lifecycle (intake → enrich → promote/dismiss)
- `src/__tests__/system-deckscience.test.ts` — slot lookup + appointment validation (no real bookings)
- `src/__tests__/system-multitenant.test.ts` — portal token cross-tenant isolation
- `src/__tests__/system-permissions.test.ts` — feature gates over the wire (viewer 403 vs unauth 401)

### Live-API (provisions real Twilio numbers — costs money)

```bash
SYSTEM_TEST_URL=$BASE_URL npm run test:live-api
SYSTEM_TEST_URL=$BASE_URL npm run test:live-api:cleanup   # purge stragglers
```

Files in `tests/live-api/` cover full agent lifecycle, comms send, blast SMS preview/confirm, and node-editor publish + rollback against the real Retell API. **Not in CI** — gated by `SYSTEM_TEST_URL`.

### E2E (Playwright)

```bash
npx playwright install chromium  # one-time
npm run test:e2e                 # headless
npm run test:e2e:ui              # interactive UI
```

Specs in `tests/e2e/` cover dashboard, shadow toggle, node editor, form, portal, form builder, command palette, history nav, tab preserve, fine-tunes API.

---

## Deployment

Deployed on **Railway** (project `servicecall-prod`, environment `production`, service `servicecall-api`) via Docker:

```dockerfile
# Multi-stage: node:20-alpine
# 1. Builder — install all deps + tsc
# 2. Runtime — copy dist/ + production deps only
# Exposes port 3000
```

`git push origin main` → Railway redeploys automatically. Pre-deploy hook runs `tsc --noEmit` + `vitest run`.

The CLI is linked locally:

```bash
railway status     # confirm linked project/env
railway logs       # tail prod logs
railway variables  # inspect env (read-only via this README)
```

---

## Security

- **Webhook signatures** — Retell HMAC-SHA256 verified on every `/retell/*` call (raw body captured pre-parse).
- **HTML escaping** — all caller-provided values escaped in email HTML output (`src/lib/escape-html.ts`).
- **Constant-time secret compares** — `API_KEY` and `ROOT_PASSWORD` compared via `crypto.timingSafeEqual` to defeat timing oracles.
- **Login lockout** — 5 failed Basic-auth attempts in 15 min → 15 min freeze, per username.
- **Session cookie HMAC** — independent of `ROOT_PASSWORD`. Rotating `SESSION_SECRET` invalidates every active session exactly once.
- **Email enumeration defense** — `POST /portal/request-link` always responds the same shape with a constant-time delay so an attacker can't probe registered emails by response time.
- **Per-feature RBAC** — every dashboard write goes through `requireFeature(feature, level)`; defaults stored in MongoDB and refreshable without redeploy.
- **Header redaction in logs** — `Authorization`, `Cookie`, `x-api-key`, and webhook signatures are redacted from request logs.
- **Rate limits** — global + per-route (webhooks, portal, auth) caps in `src/index.ts`.
- **Retry with backoff** — SMS and email dispatch retry up to 3 times with jitter (`src/lib/retry.ts`).
- **Email delivery monitoring** — Resend status checked 5 s after send; bounced/delayed mail alerts the owner via SMS.
- **Audit log** — every privileged action (delete, restore, settings change, comms send) appended to `audit_log` with user, target, and metadata.
