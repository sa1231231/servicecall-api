import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, apiGet, apiPost, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

interface DpResponse {
  paths: Array<{
    name: string;
    transitionFinetuneExamples?: Array<{ type: string; transcript: any[]; id?: string; destination?: string }>;
    dataPoints: Array<{
      variableName: string;
      collectNodeId: string;
      finetuneExamples?: Array<{ type: string; transcript: any[]; id?: string }>;
    }>;
  }>;
}

const NODES_URL = `/dashboard/api/agents/${TEST_AGENT.slug}/nodes/${TEST_AGENT.agentId}`;

// Hits the live save-and-publish endpoint, which in turn pushes the modified
// flow to Retell. Each test seeds a marker example, asserts it round-trips
// through GET, and then clears it back to the original in a cleanup block so
// the shared the test agent agent is left as-found.
test.describe("Fine-tune mutations roundtrip through save-and-publish + Retell", () => {
  test("dataPointFinetunes: POST writes, GET reads back, push to Retell occurs", async () => {
    const before = await apiGet<DpResponse>(env, NODES_URL);
    const path = before.paths[0];
    expect(path, "the test agent has at least one path").toBeDefined();
    const dp = path.dataPoints[0];
    expect(dp, "first path has at least one data point").toBeDefined();
    const collectId = dp.collectNodeId;
    const originalExamples = dp.finetuneExamples ?? [];

    const marker = `MARKER_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newExample = {
      type: "positive" as const,
      transcript: [
        { content: marker, role: "user" },
        { content: "Got it.", role: "agent" },
      ],
      id: `e2e-ft-${marker}`,
    };

    try {
      // Apply
      const saveResp = await apiPost<{ success: boolean }>(env, `${NODES_URL}/save-and-publish`, {
        changes: { dataPointFinetunes: { [collectId]: [...originalExamples, newExample] } },
      });
      expect(saveResp.success).toBe(true);

      // Read back — proves the canonical flow stored on the agent doc
      // matches what we just wrote, AND that pullLatest from Retell on
      // the next GET still surfaces the example (it round-tripped through
      // Retell's flow update).
      const after = await apiGet<DpResponse>(env, NODES_URL);
      const afterDp = after.paths[0].dataPoints.find((d) => d.collectNodeId === collectId);
      const afterExamples = afterDp?.finetuneExamples ?? [];
      const written = afterExamples.find((ex) =>
        JSON.stringify(ex.transcript).includes(marker),
      );
      expect(written, `marker ${marker} should be present in finetune examples after save`).toBeDefined();
      expect(written!.type).toBe("positive");
    } finally {
      // Cleanup — restore exactly what was there to start. Even if the
      // assertions above fail, this should bring the agent back to a clean
      // state so subsequent runs see a stable fixture.
      await apiPost(env, `${NODES_URL}/save-and-publish`, {
        changes: { dataPointFinetunes: { [collectId]: originalExamples } },
      });
    }
  });

  test("transitionFinetunes: POST writes, GET reads back, only the targeted path mutates", async () => {
    const before = await apiGet<DpResponse>(env, NODES_URL);
    const path = before.paths[0];
    const originalTransExamples = path.transitionFinetuneExamples ?? [];

    const marker = `TRANS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const newExample = {
      type: "positive" as const,
      transcript: [{ content: marker, role: "user" }],
      id: `e2e-trans-${marker}`,
    };

    try {
      const saveResp = await apiPost<{ success: boolean }>(env, `${NODES_URL}/save-and-publish`, {
        changes: { transitionFinetunes: { [path.name]: [...originalTransExamples, newExample] } },
      });
      expect(saveResp.success).toBe(true);

      const after = await apiGet<DpResponse>(env, NODES_URL);
      const afterPath = after.paths.find((p) => p.name === path.name);
      const written = (afterPath?.transitionFinetuneExamples ?? []).find((ex) =>
        JSON.stringify(ex.transcript).includes(marker),
      );
      expect(written, `transition marker ${marker} should round-trip`).toBeDefined();

      // Sibling paths' transition examples must be unaffected by the targeted edit.
      for (const otherPath of after.paths) {
        if (otherPath.name === path.name) continue;
        const beforeOther = before.paths.find((p) => p.name === otherPath.name);
        const beforeCount = (beforeOther?.transitionFinetuneExamples ?? []).length;
        const afterCount = (otherPath.transitionFinetuneExamples ?? []).length;
        expect(afterCount, `path "${otherPath.name}" transition examples must not change`).toBe(beforeCount);
      }
    } finally {
      await apiPost(env, `${NODES_URL}/save-and-publish`, {
        changes: { transitionFinetunes: { [path.name]: originalTransExamples } },
      });
    }
  });
});
