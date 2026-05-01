import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Node Editor — read-only smoke", () => {
  test("opening the Node Editor for Demo Meter renders the parsed flow", async ({ page }) => {
    await page.goto("/dashboard");

    // Click Demo Meter row to open detail view. The click triggers showDetail()
    // which fetches /dashboard/api/agents/demo-meter — we need that fetch to
    // resolve BEFORE clicking the Node Editor tab, otherwise switchAgentTab's
    // lazy-load gate (`originalDoc?.agent_id`) is false and loadNodeEditor
    // never fires.
    const row = page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/dashboard/api/agents/${DEMO_METER.slug}`) &&
          r.request().method() === "GET",
        { timeout: 15_000 },
      ),
      row.click(),
    ]);

    // Now originalDoc is populated. Click the Node Editor tab and wait for
    // its lazy-loaded nodes endpoint to come back.
    const [nodesResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/nodes/${DEMO_METER.agentId}`) &&
          !r.url().includes("/versions") &&
          r.request().method() === "GET",
        { timeout: 25_000 },
      ),
      page.locator('button.agent-tab[data-tab="nodes"]').click(),
    ]);
    expect(nodesResp.ok()).toBe(true);

    // After the response, renderNodeEditor populates #nodeEditorContainer.
    const editor = page.locator("#nodeEditorContainer");

    // Sanity checks: render is alive and a couple of canonical sections show.
    await expect(editor).toContainText("Node Editor", { timeout: 10_000 });
    await expect(editor).toContainText("System Prompt");
    await expect(editor).toContainText("Identity & Routing Paths");

    // Demo Meter is multi-path — at least one path name shows up in the
    // rendered editor.
    await expect(editor).toContainText(/measure_me|dont_measure_me/);
  });
});
