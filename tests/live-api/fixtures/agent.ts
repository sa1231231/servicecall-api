import { apiFetch, apiGet, apiPost, apiDelete } from "../lib/api-client.js";
import { generateE2eSlug } from "../lib/slug.js";
import { assertNumberReleased, ownsNumber } from "../lib/twilio-verifier.js";
import { assertAgentDeleted, getAgent } from "../lib/retell-verifier.js";

// Test agent fixture.
//
// Creates a fresh agent against the live Railway API:
//   - provisions a Twilio number (the slow + costly bit, ~$1)
//   - publishes a Retell flow + agent
//   - persists the client doc to Mongo
//
// The returned `cleanup()` is idempotent and safe to call from a
// `try/finally`. It hard-deletes via DELETE /deleted-agents/:slug
// (which transitively calls releaseAgentResources for full Twilio +
// Retell cleanup), then verifies via direct Twilio + Retell API that
// the resources are actually gone. Throws if cleanup didn't release.
//
// All fixtures created during a vitest run are tracked in `_active`
// so the suite-level afterAll can sweep any that the test forgot to
// clean (in case the test crashed before reaching `finally`).

export interface TestAgent {
  /** e2e-{date}-{rand} slug — also used as the Retell agent_name and Twilio friendlyName. */
  slug: string;
  /** Returned by POST /agents — the Retell agent_id. */
  agentId: string;
  /** The conversation_flow_id Retell created. */
  conversationFlowId: string;
  /** The provisioned Twilio number in E.164. May be null if provisioning is disabled. */
  phoneNumber: string | null;
  /** Idempotent cleanup — hard-deletes via the dashboard API and verifies. */
  cleanup: () => Promise<void>;
  /** Mark this fixture as already cleaned so the suite-level sweep skips it. */
  _markCleaned: () => void;
}

interface CreateOptions {
  /** Provide an explicit slug; otherwise one is generated. */
  slug?: string;
  /** Override the displayed business name (defaults to the slug). */
  businessName?: string;
  /** Force shadow_mode true/false; defaults to true so any accidental
   *  dispatch lands on the owner phone, not the test dispatch list. */
  shadowMode?: boolean;
  /** Skip provisioning a Twilio number. Use for tests that don't need
   *  inbound (saves ~$1 per test). */
  skipProvisioning?: boolean;
}

const _active = new Set<TestAgent>();

/** Used by the suite-level afterAll. Returns the count of stragglers
 *  cleaned up — non-zero means a test crashed before its `finally`. */
export async function sweepActiveFixtures(): Promise<number> {
  const stragglers = Array.from(_active);
  let cleaned = 0;
  for (const a of stragglers) {
    try {
      await a.cleanup();
      cleaned++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[e2e-sweep] cleanup of ${a.slug} failed:`, msg);
    }
  }
  return cleaned;
}

/** Number of fixtures still tracked. */
export function activeFixtureCount(): number {
  return _active.size;
}

export async function createTestAgent(opts: CreateOptions = {}): Promise<TestAgent> {
  const slug = opts.slug ?? generateE2eSlug();
  const businessName = opts.businessName ?? `E2E Test Agent ${slug.slice(-6)}`;
  const shadowMode = opts.shadowMode ?? true;

  // Read owner_phone from settings — that's where shadow-mode dispatch
  // lands, and it's the only phone we know is safe to send test SMS to.
  const settings = await apiGet<{ owner_phone?: string }>("/dashboard/api/settings");
  if (!settings.owner_phone) {
    throw new Error("Cannot create test agent: settings.owner_phone is not set on the production server");
  }
  const ownerPhone = settings.owner_phone;

  // Minimal viable agent config — single path, three data points, shadow on.
  const body = {
    business: {
      businessName,
      faqKnowledgeBase: `This is an automated end-to-end test agent (${slug}). Hours: 24/7. Service area: nowhere — do not send a real tech.`,
    },
    paths: [
      {
        name: "service_call",
        transitionCondition: "the caller wants to schedule service",
        dataPoints: ["first_name", "last_name", "phone_number"],
        end_mode: "callback" as const,
      },
    ],
    client: {
      slug,
      name: businessName,
      dispatch_text_numbers: [ownerPhone],
      dispatch_email: null,
      shadow_mode: shadowMode,
    },
    // The provisioning step inside createAgentFromConfig will skip when
    // the Twilio creds aren't fully configured. There's no input flag to
    // force-skip from the request body, so we rely on the env to decide.
    // (skipProvisioning is reserved for future use.)
  };

  const created = await apiPost<{
    success: boolean;
    slug: string;
    agent_id: string;
    conversation_flow_id: string;
    provisioned_number: string | null;
    provision_error: string | null;
  }>("/agents/create", body);

  const agent: TestAgent = {
    slug: created.slug,
    agentId: created.agent_id,
    conversationFlowId: created.conversation_flow_id,
    phoneNumber: created.provisioned_number,
    cleanup: async () => {
      // Idempotent: bail if we've already been cleaned.
      if (!_active.has(agent)) return;
      // Soft-delete first (sets deletedAt), then permanent-delete via the
      // recovery endpoint which calls releaseAgentResources.
      const softResp = await apiFetch(`/dashboard/api/agents/${created.slug}`, {
        method: "DELETE",
        expectError: true,
      });
      // 200 (success) or 404 (already gone) are both fine.
      if (softResp.status !== 200 && softResp.status !== 404) {
        throw new Error(`soft-delete of ${created.slug} returned ${softResp.status}`);
      }
      const hardResp = await apiFetch(`/dashboard/api/deleted-agents/${created.slug}`, {
        method: "DELETE",
        expectError: true,
      });
      if (hardResp.status !== 200 && hardResp.status !== 404) {
        throw new Error(`hard-delete of ${created.slug} returned ${hardResp.status}`);
      }
      // Verify the cleanup actually propagated.
      await assertAgentDeleted(created.agent_id);
      if (created.provisioned_number) {
        await assertNumberReleased(created.provisioned_number);
      }
      _active.delete(agent);
    },
    _markCleaned: () => { _active.delete(agent); },
  };
  _active.add(agent);
  return agent;
}

/** Re-export common verifiers so test files only need one import. */
export { ownsNumber, getAgent };
