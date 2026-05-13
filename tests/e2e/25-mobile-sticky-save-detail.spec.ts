import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Agent detail Save buttons on mobile (≤768px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("Save Settings inside agent detail is sticky-positioned", async ({ page }) => {
    await page.goto("/dashboard");
    const row = page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    await expect(page.locator("#detailView")).toBeVisible({ timeout: 10_000 });
    // The agent detail's own Save Settings button (different element than the
    // global settings one — shares an id but lives inside #detailView).
    const btn = page.locator("#detailView #btnSaveSettings");
    await expect(btn).toBeVisible({ timeout: 10_000 });

    const position = await btn.evaluate(
      (el) => window.getComputedStyle(el).position,
    );
    expect(position).toBe("sticky");

    const bottomPx = await btn.evaluate(
      (el) => parseFloat(window.getComputedStyle(el).bottom) || 0,
    );
    expect(bottomPx).toBeGreaterThanOrEqual(64);
  });
});
