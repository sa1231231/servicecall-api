import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Pending lead detail — tabs (M3)", () => {
  test("clicking a lead reveals the 3-tab nav (Lead Info · AI Enrichment · Promote)", async ({ page }) => {
    await page.goto("/dashboard#leads");
    await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(
      () => !document.querySelector("#pendingLeadsBody .loading"),
      undefined,
      { timeout: 15_000 },
    );

    // Skip cleanly when prod fixture has no leads.
    const rowCount = await page.locator("#pendingLeadsBody tbody tr").count();
    test.skip(rowCount === 0, "No pending leads in production fixture");

    // Click the first lead row.
    await page.locator("#pendingLeadsBody tbody tr").first().click();
    const tabs = page.locator(".lead-tabs .lead-tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toContainText("Lead Info");
    await expect(tabs.nth(1)).toContainText("AI Enrichment");
    await expect(tabs.nth(2)).toContainText("Promote");

    // Exactly one pane should be visible.
    const visiblePanes = await page.locator(".lead-tab-pane.active").count();
    expect(visiblePanes).toBe(1);

    // Switching tabs reveals a different pane.
    await page.locator('[data-lead-tab="info"]').click();
    await expect(page.locator('[data-lead-tab-pane="info"]')).toHaveClass(/active/);
  });
});
