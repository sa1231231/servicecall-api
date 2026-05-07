import { describe, it, expect, afterAll } from "vitest";
import { hasFullEnv } from "./lib/env.js";
import { apiGet, apiPost } from "./lib/api-client.js";
import { createTestAgent, sweepActiveFixtures } from "./fixtures/agent.js";
import { getAgent } from "./lib/retell-verifier.js";

// Node editor — edit global prompt → publish → list versions → rollback.
//
// Verifies the pull-edit-push-rollback cycle ends-to-end:
//   1. Pull canonical from Retell (GET /:agentId)
//   2. Edit the global prompt (POST /:agentId/edit-global-prompt)
//      — this snapshots, edits, validates, pushes to Retell
//   3. Confirm Retell flow now has the new prompt
//   4. List version history — confirm the snapshot is there
//   5. Rollback to the prior version (POST /:agentId/rollback)
//   6. Confirm Retell flow has the original prompt back

describe.skipIf(!hasFullEnv)(
  "[live-api] node_editor (edit + publish + rollback)",
  { timeout: 180_000 },
  () => {
    afterAll(async () => {
      const swept = await sweepActiveFixtures();
      if (swept > 0) throw new Error(`Suite-level sweep cleaned up ${swept} fixture(s) — leak detected`);
    });

    it("edits a global prompt, publishes to Retell, then rolls back", async () => {
      const agent = await createTestAgent();
      try {
        // 1. Pull canonical so we know the original prompt.
        const initial = await apiGet<{ canonicalJson: { conversationFlow: { global_prompt?: string } } }>(
          `/dashboard/api/agents/${agent.slug}/nodes/${agent.agentId}`,
        );
        const originalPrompt = initial.canonicalJson.conversationFlow.global_prompt ?? "";

        // 2. Edit + publish.
        const newPrompt = `${originalPrompt}\n\nE2E test marker: ${agent.slug}`;
        await apiPost(`/dashboard/api/agents/${agent.slug}/nodes/${agent.agentId}/edit-global-prompt`, {
          globalPrompt: newPrompt,
        });

        // 3. Pull again — Retell should report the new prompt.
        // Give the post-publish sync a beat (Retell's eventual consistency).
        await new Promise((r) => setTimeout(r, 1500));
        const afterEdit = await apiGet<{ canonicalJson: { conversationFlow: { global_prompt?: string } } }>(
          `/dashboard/api/agents/${agent.slug}/nodes/${agent.agentId}`,
        );
        expect(afterEdit.canonicalJson.conversationFlow.global_prompt).toBe(newPrompt);

        // 4. Versions list should now contain at least one snapshot
        // (created by edit-global-prompt before applying the change).
        const versions = await apiGet<{ versions: Array<{ _id: string; description: string }> }>(
          `/dashboard/api/agents/${agent.slug}/nodes/${agent.agentId}/versions`,
        );
        expect(versions.versions.length).toBeGreaterThan(0);
        const editSnapshot = versions.versions.find((v) => v.description === "Edit global prompt");
        expect(editSnapshot, "no 'Edit global prompt' snapshot found in version history").toBeDefined();

        // 5. Rollback to that snapshot.
        await apiPost(`/dashboard/api/agents/${agent.slug}/nodes/${agent.agentId}/rollback`, {
          versionId: editSnapshot!._id,
        });

        // 6. Retell should report the ORIGINAL prompt back.
        await new Promise((r) => setTimeout(r, 1500));
        const afterRollback = await apiGet<{ canonicalJson: { conversationFlow: { global_prompt?: string } } }>(
          `/dashboard/api/agents/${agent.slug}/nodes/${agent.agentId}`,
        );
        expect(afterRollback.canonicalJson.conversationFlow.global_prompt).toBe(originalPrompt);

        // Sanity: verify Retell directly (not just our cached read).
        const retell = await getAgent(agent.agentId);
        expect(retell).not.toBeNull();
      } finally {
        await agent.cleanup();
      }
    });
  },
);
