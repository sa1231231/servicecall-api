import { describe, it, expect, afterAll } from "vitest";
import { hasFullEnv, describeMissingEnv } from "./lib/env.js";
import { apiGet, apiFetch } from "./lib/api-client.js";
import {
  createTestAgent,
  sweepActiveFixtures,
  activeFixtureCount,
  ownsNumber,
} from "./fixtures/agent.js";
import { getAgent, assertAgentDeleted, assertAgentUnbound } from "./lib/retell-verifier.js";
import { assertNumberReleased } from "./lib/twilio-verifier.js";

// Highest-value E2E test: the full agent_lifecycle + permanent_delete
// path. Proves that releaseAgentResources actually releases Twilio
// numbers and deletes Retell agents in production. Without this, we
// have no end-to-end confirmation that the cleanup contract works.

describe.skipIf(!hasFullEnv)(
  "[live-api] agent lifecycle (create → soft-delete → restore → permanent-delete)",
  { timeout: 180_000 },
  () => {
    afterAll(async () => {
      const swept = await sweepActiveFixtures();
      if (swept > 0) {
        throw new Error(
          `Suite-level sweep cleaned up ${swept} leaked fixture(s) — a test crashed before its cleanup ran. Failing the run.`,
        );
      }
      expect(activeFixtureCount()).toBe(0);
    });

    it("env is fully configured", () => {
      expect(hasFullEnv, describeMissingEnv()).toBe(true);
    });

    it("creates an agent end-to-end and verifies all the resources land", async () => {
      const agent = await createTestAgent();
      try {
        // 1. Mongo doc exists with the slug
        const doc = await apiGet<{ name: string; agent_id: string }>(`/dashboard/api/agents/${agent.slug}`);
        expect(doc.agent_id).toBe(agent.agentId);

        // 2. Retell agent exists
        const retellAgent = await getAgent(agent.agentId);
        expect(retellAgent).not.toBeNull();

        // 3. Twilio number is owned by the account (if provisioning succeeded)
        if (agent.phoneNumber) {
          expect(await ownsNumber(agent.phoneNumber)).toBe(true);
        }
      } finally {
        await agent.cleanup();
      }
    });

    it("soft-deletes, restores, soft-deletes, then permanently deletes — verifies full Twilio + Retell cleanup", async () => {
      const agent = await createTestAgent();
      let cleaned = false;
      try {
        // Soft-delete
        const softResp = await apiFetch(`/dashboard/api/agents/${agent.slug}`, {
          method: "DELETE",
        });
        expect(softResp.status).toBe(200);
        // Now in deleted-agents list
        const deleted = await apiGet<Array<{ _id: string }>>(`/dashboard/api/deleted-agents`);
        expect(deleted.some((d) => d._id === agent.slug)).toBe(true);

        // Restore
        const restoreResp = await apiFetch(`/dashboard/api/deleted-agents/${agent.slug}/restore`, {
          method: "POST",
        });
        expect(restoreResp.status).toBe(200);
        // Confirm via Retell that the [DELETED] suffix was stripped from the agent name
        const restoredAgent = await getAgent(agent.agentId) as { agent_name?: string } | null;
        expect(restoredAgent).not.toBeNull();
        expect(restoredAgent?.agent_name).not.toMatch(/\[DELETED/);

        // Soft-delete again, then permanent-delete
        await apiFetch(`/dashboard/api/agents/${agent.slug}`, { method: "DELETE" });
        const hardResp = await apiFetch(`/dashboard/api/deleted-agents/${agent.slug}`, {
          method: "DELETE",
        });
        expect(hardResp.status).toBe(200);

        // The dashboard already returns released_numbers + cleanup_errors
        // in the response. Assert we got both.
        const hardBody = hardResp.body as { success?: boolean; released_numbers?: unknown[]; cleanup_errors?: unknown[] };
        expect(hardBody.success).toBe(true);
        // cleanup_errors should be empty on a happy-path delete.
        expect(hardBody.cleanup_errors ?? []).toEqual([]);

        // Now verify directly against Retell + Twilio.
        await assertAgentDeleted(agent.agentId);
        await assertAgentUnbound(agent.agentId);
        if (agent.phoneNumber) {
          await assertNumberReleased(agent.phoneNumber);
        }

        // Mark our fixture as cleaned so the suite-level sweep doesn't
        // try to re-clean (we already hard-deleted manually).
        agent._markCleaned();
        cleaned = true;
      } finally {
        if (!cleaned) await agent.cleanup();
      }
    });
  },
);
