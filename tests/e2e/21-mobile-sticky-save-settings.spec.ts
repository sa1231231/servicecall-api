import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Settings Save button on mobile (≤768px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("Save Settings is sticky-positioned at the bottom on mobile", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    const btn = page.locator("#btnSaveSettings");
    await expect(btn).toBeVisible();

    const position = await btn.evaluate(
      (el) => window.getComputedStyle(el).position,
    );
    expect(position).toBe("sticky");

    const box = await btn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("Save Settings has a bottom offset that clears the mobile-tab-bar", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    // The mobile-tab-bar reserves 64px + safe-area, so the sticky button's
    // bottom must be at least 64px to avoid overlap.
    const bottomPx = await page.locator("#btnSaveSettings").evaluate((el) => {
      const raw = window.getComputedStyle(el).bottom;
      return parseFloat(raw) || 0;
    });
    expect(bottomPx).toBeGreaterThanOrEqual(64);
  });
});
