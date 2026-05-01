import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Node Editor — read-only smoke", () => {
  test("opening the Node Editor for Demo Meter renders the parsed flow", async ({ page }) => {
    await page.goto("/dashboard");

    // Click Demo Meter row to open detail view.
    const row = page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // Detail view should switch in.
    await expect(page.locator("#detailView")).toBeVisible({ timeout: 10_000 });

    // Click the Node Editor tab — switchAgentTab('nodes') triggers a
    // lazy load of the node editor data.
    await page.locator('[data-tab="nodes"]').click();

    // The editor renders an <h2>Node Editor</h2> heading once data is ready.
    const editor = page.locator("#nodeEditorContainer");
    await expect(editor.getByRole("heading", { name: "Node Editor" })).toBeVisible({
      timeout: 20_000, // Retell fetch can be slow on cold start
    });

    // Verify the Global Prompt section rendered with non-empty text.
    await expect(editor).toContainText("Global Prompt");

    // Verify at least one of Demo Meter's known paths shows up.
    // Demo Meter is a multi-path agent: measure_me + dont_measure_me.
    await expect(editor).toContainText(/measure_me|dont_measure_me/);
  });
});
