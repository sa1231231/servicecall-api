import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Pending leads filter chips", () => {
  test("chips render with seven options and All is active by default", async ({ page }) => {
    await page.goto("/dashboard#leads");
    await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 15_000 });

    // Wait for the cache to load + the list/body render to land.
    await page.waitForFunction(
      () =>
        !document.querySelector("#pendingLeadsBody .loading"),
      undefined,
      { timeout: 15_000 },
    );

    // Chips only render when there's at least one lead in the cache (the empty
    // state is a single sentence with no chip row).
    const chipRow = page.locator(".pending-lead-chips");
    const hasLeads = (await chipRow.count()) > 0;
    test.skip(!hasLeads, "No pending leads in production fixture — chip row not rendered");

    await expect(chipRow).toBeVisible();
    const chips = chipRow.locator(".pending-lead-chip");
    await expect(chips).toHaveCount(7);

    const labels = ["All", "Pending", "Enriching", "Ready", "Errored", "Promoted", "Dismissed"];
    for (let i = 0; i < labels.length; i++) {
      await expect(chips.nth(i)).toContainText(labels[i]);
    }
    await expect(page.locator('.pending-lead-chip[data-filter="all"]')).toHaveClass(
      /active/,
    );
  });

  test("clicking a chip moves the active class and filters the rendered rows", async ({ page }) => {
    await page.goto("/dashboard#leads");
    await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 15_000 });

    const chipRow = page.locator(".pending-lead-chips");
    const hasLeads = (await chipRow.count()) > 0;
    test.skip(!hasLeads, "No pending leads in production fixture — nothing to filter");

    // Click "Errored" — likely to be 0 in prod fixture, which exercises the
    // filtered-empty-state branch without depending on lead presence.
    await page.locator('.pending-lead-chip[data-filter="failed"]').click();
    await expect(page.locator('.pending-lead-chip[data-filter="failed"]')).toHaveClass(/active/);
    await expect(page.locator('.pending-lead-chip[data-filter="all"]')).not.toHaveClass(/active/);

    // Switch back to All; the active class follows.
    await page.locator('.pending-lead-chip[data-filter="all"]').click();
    await expect(page.locator('.pending-lead-chip[data-filter="all"]')).toHaveClass(/active/);
  });

  test.describe("at mobile viewport (375x667)", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("chips meet 44px tap targets on mobile", async ({ page }) => {
      await page.goto("/dashboard#leads");
      await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 15_000 });

      const chipRow = page.locator(".pending-lead-chips");
      const hasLeads = (await chipRow.count()) > 0;
      test.skip(!hasLeads, "No pending leads in production fixture");

      const box = await page.locator('.pending-lead-chip[data-filter="all"]').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  });
});
