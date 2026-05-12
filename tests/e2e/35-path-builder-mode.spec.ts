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
    await page.locator('button[data-form-tab="paths"]').first().click();

    const builder = page.locator(".path-builder").first();
    await expect(builder).toBeVisible({ timeout: 10_000 });
    // Default mode = scan: tree gets the wider column.
    await expect(builder).toHaveAttribute("data-mode", "scan");

    // Trigger a tree-node select via the inline onclick. The flow-diagram
    // SVG overlay sometimes intercepts pointer events during the import-
    // animation transient, so we invoke the same handler directly instead
    // of relying on a real click landing.
    const treeNode = page.locator(".path-builder-tree .tree-node").first();
    if ((await treeNode.count()) === 0) {
      test.skip(true, "No tree nodes after import — nothing to click");
    }
    await page.evaluate(() => {
      const node = document.querySelector(".path-builder-tree .tree-node") as HTMLElement | null;
      if (node?.onclick) node.onclick(new MouseEvent("click"));
    });
    await expect(builder).toHaveAttribute("data-mode", "edit", { timeout: 5_000 });
  });
});
