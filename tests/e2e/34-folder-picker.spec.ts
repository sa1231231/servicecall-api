import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Folder picker dropdown (M4)", () => {
  test("Folders button opens a dropdown listing folders + counts", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    await page.locator("#folderPickerBtn").click();
    const menu = page.locator("#folderPickerMenu");
    await expect(menu).toBeVisible();

    // Either a folder list OR the empty-state message renders.
    const itemCount = await menu.locator(".folder-picker-item").count();
    const emptyState = menu.locator("text=No folders yet");
    if (itemCount === 0) {
      await expect(emptyState).toBeVisible();
    } else {
      await expect(menu.locator(".folder-picker-item").first()).toBeVisible();
    }
  });

  test("clicking a folder name adds it as a search chip", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    await page.locator("#folderPickerBtn").click();
    const menu = page.locator("#folderPickerMenu");
    await expect(menu).toBeVisible();

    const items = menu.locator(".folder-picker-item");
    const count = await items.count();
    test.skip(count === 0, "No folders defined in production fixture");

    const firstFolderName = await items.first().locator(".folder-picker-name").textContent();
    await items.first().click();

    // Chip appears in the search-chips container.
    await expect(page.locator("#agentSearchChips")).toContainText(firstFolderName!.trim());
  });
});
