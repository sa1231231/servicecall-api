# Test strategy

Five layers of tests live in this repo. Each runs in a different environment with different cost / speed / blast-radius tradeoffs. **When adding a new test, pick the lowest layer that can prove the thing.**

## TL;DR

| Layer | Runner | Where it runs | When it runs | What it covers |
|---|---|---|---|---|
| **Unit** | vitest | local + CI | every push | pure functions, parsing, generation, validation |
| **System** | vitest | local against deployed URL | manual (`npm run test:system`) | server routes, DB-backed contracts, end-to-end through Express |
| **Live-API** | vitest | local against deployed URL + real Retell/Twilio | manual (`npm run test:live-api`) | full agent lifecycle including external SDK calls |
| **E2E (UI)** | Playwright | local against deployed URL | manual (`npm run test:e2e`) | browser-driven user flows on the dashboard / form / portal |
| **QA-sim** | tsx CLI | local + Retell chat clones + Anthropic | manual, R&D loop (`tsx tools/qa-sim/run.ts ...`) | full synthetic call simulations against a voice agent (cloned to chat), LLM-graded against per-scenario acceptance criteria |

Run counts as of the last update of this file: ~1,800 unit · ~250 system · ~10 live-api · ~80 e2e · ~10 scenarios per qa-sim run.

---

## 1. Unit tests (vitest, fast, cheap, in CI)

**Where:** `src/**/__tests__/*.test.ts` and `tools/**/__tests__/*.test.ts`
**Run:** `npm test` (or `npm run test:watch`)
**Talks to:** nothing external — mocks where needed
**Triggered by:** GitHub Actions on every push to main + every PR

### What goes here
- Pure utility logic (slug normalization, date formatting, validators).
- Conversation-flow generation and parsing (`src/lib/agent-generator`, `src/lib/node-parser`).
- One-shot tools logic — extract pure functions and unit-test them. See `tools/migrate-add-close-question.ts` (logic exported as `migrateOneFlow`, tested separately).
- Snapshot tests for stable structural output (e.g. `agent-generator.snapshot.test.ts`). Use a sanitizer that strips generated IDs so the snapshot survives across runs.

### What NOT to put here
- Anything that needs MongoDB → use a system test.
- Anything that needs the Retell SDK → use a live-api test.
- Anything that needs a browser → use Playwright.

### Coverage gate
`vitest.config.ts` enforces 85% statements / 75% branches / 80% functions / 85% lines (against `src/**/*.ts`). When you add a new module under `src/lib` or `src/routes`, you'll usually need a sibling `__tests__` file to keep the gate green.

---

## 2. System tests (vitest, against the deployed API)

**Where:** `src/__tests__/system*.test.ts`
**Run:** `SYSTEM_TEST_URL=$BASE_URL API_KEY=... ROOT_PASSWORD=... npm run test:system:all`
**Talks to:** the deployed Railway URL (typically production), real MongoDB
**Triggered by:** humans, before / after a meaningful server-side change

### What goes here
- Express route contracts — request shape, status codes, response shape.
- DB-backed reads (lists, filters, aggregations).
- Auth + permissions (does a viewer get 403 on write endpoints? does `admin` + `ROOT_PASSWORD` succeed?).
- Cross-feature flows that don't hit the Retell SDK (e.g. clone agent, soft delete, audit log queries).

### What NOT to put here
- UI behavior — use Playwright.
- Anything that creates a real Retell agent or Twilio number — use live-api.
- Heavy mutation tests against shared resources. Most system tests are read-only or quickly self-clean.

### The gating mechanism
`SYSTEM_TEST_URL` (or `BASE_URL`) MUST be set, otherwise the suite no-ops. Without it the tests just early-return — they will NOT run against a local dev server unless you point the env at one.

---

## 3. Live-API tests (vitest, against the deployed API + real Retell/Twilio)

**Where:** `tests/live-api/**/*.test.ts`
**Run:** `npm run test:live-api`
**Talks to:** deployed Railway URL + real Retell SDK + real Twilio numbers
**Triggered by:** humans, before a release that touches agent lifecycle or comms

### What goes here
- Full agent lifecycle: create from form → publish → verify in Retell → delete → release Twilio number.
- Send-comms flows that allocate real numbers (`tests/live-api/send-comms.test.ts`).
- SMS blast preview + confirm (`tests/live-api/sms-blast.test.ts`) — small audience or dry-run.
- Anything that exercises the full Retell `conversationFlow.create` → `conversationFlow.update` → `agent.delete` round-trip.

### What NOT to put here
- Anything that costs more than a couple of cents per run. (The full lifecycle test provisions and releases a Twilio number, which has cost. The cleanup script `npm run test:live-api:cleanup` purges any stragglers older than 1 hour.)
- UI flows.
- Anything you could prove with a system test.

### Tagging convention
Every artifact (agent name, slug, Twilio friendly_name) is prefixed with `e2e-` so the cleanup sweeper can find + remove orphans.

---

## 4. E2E browser tests (Playwright, against the deployed URL)

**Where:** `tests/e2e/*.spec.ts`
**Run:** `SYSTEM_TEST_URL=$BASE_URL E2E_USER=admin npx playwright test`
**Talks to:** deployed dashboard via a real Chromium browser
**Triggered by:** humans, before / after any UI-touching change

### What goes here
- User journeys: click X, expect Y. Always at least one e2e per visible new UI surface.
- Responsive checks at 375×667 (mobile) and 1280×800 (desktop) — most specs declare a viewport via `test.use({ viewport: ... })`.
- DOM assertions on selectors stable across renders (`#agentList`, `[data-slug=…]`, etc).
- Read-only or self-cleaning state changes. If a test must mutate prod state, restore the original in a `finally` block (see `36-settings-round-trip.spec.ts`).

### What NOT to put here
- Pure logic. Use a unit test.
- Multi-minute flows. E2E is slow — keep specs under ~15s per test.
- Fixture-dependent assertions without a `test.skip` escape hatch. The production agent list / pending lead list change over time; assertions that require a specific lead in queue must skip when the fixture isn't present.

### Tunables
- `playwright.config.ts` has `retries: 1` locally (CI: 2). A test that flakes once retries; deterministic failures still fail both attempts.
- `workers: 1` and `fullyParallel: false` — the global rate-limiter (5000 req / 15min) sits comfortably above the suite's request load, but serial execution keeps state-mutating tests from racing each other.

---

## 5. QA-sim (simulated calls + LLM-graded transcripts)

**Where:** `tools/qa-sim/*.ts` + `tools/qa-sim/__tests__/*.test.ts`
**Run:** `tsx tools/qa-sim/run.ts --slug=<slug> [--persona=ID] [--scenarios=ID,ID] [--against-baseline]`
**Talks to:** Retell (clones the voice agent → chat agent, runs the conversation, deletes the clone) + Anthropic (Haiku 4.5 for the caller bot, Sonnet 4.6 for the grader passes). Mongo for `slug → agent_id` lookup only.
**Triggered by:** humans during R&D, whenever a prompt / config / fine-tune change might move agent quality and you want hard feedback before shipping.

### What goes here
- New caller archetypes (`tools/qa-sim/personas.ts`).
- New scenario definitions (`tools/qa-sim/scenarios.ts`) — when a real production call surfaces a pattern worth canonicalizing as a test, add it here.
- Pure parsing logic in caller-bot + grader — `tools/qa-sim/__tests__/*.test.ts` covers these as standard unit tests so the eval pipeline can't be silently broken by a parser change.

### What NOT to put here
- Per-call behavioral assertions (use real transcript-analyzer findings to grade — don't reinvent the analyzer here).
- Heavy mutation tests against production agents (the runner clones to a fresh chat agent and deletes it after; never operate on the production voice agent directly).

### Cost
Roughly $0.07 per scenario in chat mode. A full ~10-scenario run is < $1. Cheap enough to fire 30× per day during active R&D iteration.

### Promoting a baseline
The diff section of `REPORT.md` compares the current run to a "baseline" snapshot. To promote a run:
```
rm -rf tools/qa-sim/runs/baseline
cp -r tools/qa-sim/runs/<timestamp> tools/qa-sim/runs/baseline
```
Subsequent runs with `--against-baseline` will then show the delta.

---

## Choosing the right layer for a new test

Ask in order:

1. **Can I prove this with pure functions and fakes?** → unit test (`src/**/__tests__`).
2. **Does this only matter when MongoDB and Express are running together?** → system test (`src/__tests__/system*`).
3. **Does this only fail when Retell or Twilio is actually called?** → live-api test (`tests/live-api`).
4. **Does this only matter when a human is clicking around in a browser?** → e2e test (`tests/e2e`).

A change might warrant tests at multiple layers — e.g. a new agent-config field might get:
- a unit test for its serialization,
- a system test for its `/dashboard/api/agents` PATCH contract,
- a live-api test if it changes what's pushed to Retell,
- an e2e test for the UI field that edits it.

But default to the lowest layer that catches regressions. Lower layers run faster, cost nothing, and tell you *which* function broke.

---

## Common patterns to mirror

- **Snapshot with sanitization:** `src/lib/__tests__/agent-generator.snapshot.test.ts` strips generated IDs + timestamps before snapshotting so the snapshot is stable across runs. Reuse this pattern for any test that captures complex generated output.
- **Test-skip when prod fixture is absent:** `tests/e2e/22-pending-leads-filters.spec.ts` calls `test.skip(rowCount === 0, ...)` so the test runs only when there's a lead to interact with. Mirror this for any test that depends on real prod data.
- **Test sentinel + revert:** `tests/e2e/36-settings-round-trip.spec.ts` writes a clearly-synthetic placeholder value, asserts persistence, then reverts in a `finally`. Use this whenever a test must mutate shared state.
- **Helpers in `tests/e2e/_helpers.ts`:** `getEnv()`, `httpCredentials()`, `apiFetch/apiGet/apiPatch/apiPost`, and the `DEMO_METER` constant. New e2e specs should import from here rather than re-rolling auth or fixture references.

---

## What's deliberately NOT tested

- Behavior under network failure (mocked retries / timeouts). Add only if a real outage exposes a regression we can't reason about.
- Browser-compat beyond Chromium. The single Playwright project is `Desktop Chrome`. Mobile viewports are tested in Chromium too; we don't run WebKit/Firefox.
- Visual-regression snapshots. The current dashboard's data (call logs, lead lists) shifts between runs, so pixel-diff snapshots would be perpetually flaky. Behavioral assertions catch most breakage; explicit field-level assertions cover the rest.
