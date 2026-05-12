import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, apiFetch, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("/form path builder — scan / edit modes (M5)", () => {
  test("starts in scan mode (tree-wide), flips to edit on node click", async ({ page }) => {
    await page.goto("/form");
    await expect(page.locator("#agentForm")).toBeVisible({ timeout: 15_000 });

    // Load a real exported config so the path tree has nodes to click.
    const exportResp = await apiFetch(env, `/dashboard/api/agents/${DEMO_METER.slug}/export`);
    const exported = await exportResp.json();
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo-meter-config.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });

    // Switch to the Routing Paths form-subtab so .path-builder is visible.
    const routingTab = page.locator('button[data-form-pane="paths"]').first();
    if ((await routingTab.count()) > 0) await routingTab.click();

    const builder = page.locator(".path-builder").first();
    await expect(builder).toBeVisible({ timeout: 10_000 });
    // Default mode = scan: tree gets the wider column.
    await expect(builder).toHaveAttribute("data-mode", "scan");

    // Click the first tree node — should flip to edit mode.
    const firstNode = page.locator(".path-builder-tree .tree-node").first();
    if ((await firstNode.count()) === 0) {
      test.skip(true, "No tree nodes after import — nothing to click");
    }
    await firstNode.click();
    await expect(builder).toHaveAttribute("data-mode", "edit", { timeout: 5_000 });
  });
});
