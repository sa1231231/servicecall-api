# Live-API E2E suite

End-to-end tests that hit the **deployed Railway API** with real
Twilio + Retell credentials. Each test creates fresh artifacts (an
agent, a Twilio phone number, a Retell flow) and **must clean them
up**, even on failure. Three layers of cleanup safety:

1. **Per-test `try/finally`** — happy path.
2. **Suite-level `afterAll`** — sweeps any fixture still tracked. Fails
   the run when it finds stragglers (silent leaks would mean phantom
   Twilio charges).
3. **`npm run test:live-api:cleanup`** — standalone sweep of any
   `e2e-*` artifacts older than 1 hour. Run manually if a CI crash
   left state behind.

## When to run

Manually, before shipping a feature that touches agent provisioning,
SMS sending, or the node editor. **Not on every push** — costs ~$2-5
per run (Twilio bills $1 minimum even for same-day-released numbers).

## Required env vars

```bash
export BASE_URL=https://servicecall-api-production.up.railway.app
export API_KEY=<production API_KEY>
export ROOT_PASSWORD=<production ROOT_PASSWORD>
export TWILIO_ACCOUNT_SID=<production Twilio SID>
export TWILIO_AUTH_TOKEN=<production Twilio auth token>
export RETELL_API_KEY=<production Retell key>
# Optional — only needed for the leads test:
export LEAD_INTAKE_TOKEN=<production lead-intake bearer token>
```

If any are missing, the suite **skips silently** (each `describe` is
gated on `hasFullEnv`).

## Running

```bash
npm run test:live-api              # run the full suite (~3-5 min)
npm run test:live-api -- lifecycle # run just lifecycle.test.ts
npm run test:live-api:cleanup      # sweep stragglers (anything e2e-* > 1h old)
```

## Coverage

| File | Feature(s) covered | Provisions a number? |
|---|---|---|
| `lifecycle.test.ts` | `agent_lifecycle:write` + `:manage`, `permanent_delete:manage` | ✅ ($1) |
| `send-comms.test.ts` | `send_comms:write` × 4 (review/payment/portal/instructions) | ✅ ($1) |
| `sms-blast.test.ts` | `sms_blast:read` (preview only — see note below) | ❌ |
| `leads.test.ts` | `pending_leads:write` (intake + bearer auth + dismiss) | ❌ |
| `node-editor.test.ts` | `node_editor:write` + `:manage` (publish + rollback) | ✅ ($1) |

### Why `sms_blast` is preview-only

The `/blast-sms` endpoint sends to **every active non-shadow client**
in the production database. Even with the confirm-recipients drift
gate, sending to real customer phones as a side effect of a test would
be catastrophic. The full send path is covered by mocked unit tests at
`src/routes/dashboard/__tests__/blast-sms-routes.test.ts`.

## Cost expectations

- Twilio numbers: **~$1 per test that provisions** (Twilio's first-month
  minimum is non-prorated). 3 of 5 tests provision. Total: **~$3** per
  full run.
- SMS: $0.0079 each. ~10 sends per run. Total: **<$0.10**.
- Retell agents/flows: free to create + delete.
- Anthropic enrichment (leads test): ~$0.05 per run.

**Estimated full run cost: $3-5.**

## Slug convention

Every artifact created by this suite uses the prefix
`e2e-{YYYY-MM-DD}-{6-hex-rand}`:

- MongoDB: client doc `_id` (slug)
- Retell: agent `agent_name`
- Twilio: phone number `friendlyName`

Distinctive enough for the cleanup sweeper to filter on; the date
prefix makes stale leaks obvious in the Twilio console.

## Troubleshooting

**Suite says "leak detected" and fails:**
A test threw before its `finally` ran. Check the test logs for the
original failure, then run `npm run test:live-api:cleanup` to verify
the sweeper handled the orphans.

**Cleanup sweeper finds nothing but Twilio shows e2e-* numbers:**
The numbers are < 1 hour old and the sweeper's age filter skipped
them. Re-run with `MIN_AGE_HOURS=0 npm run test:live-api:cleanup`.

**Tests time out at the create step:**
Check the Railway logs for provisioning errors — usually means
Twilio's `availablePhoneNumbers` query returned zero results for the
default search (US local numbers). The lib's `provisionPhoneNumber`
falls back gracefully but the test's 60s timeout may not be enough.

**Want to run against a staging URL instead of production:**
Just point `BASE_URL` at the staging deploy. Note that staging needs
its own Twilio + Retell credentials (don't share with prod).
