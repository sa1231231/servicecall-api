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

  test("Save Settings stays in view after scrolling to bottom of a tall pane", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    // Categories is reliably tall (data point editor + create-new forms).
    await page.locator('[data-settings-tab="categories"]').click();
    await expect(page.locator("#settings-tab-categories")).toHaveClass(/active/);

    // Scroll all the way down inside the page.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    const btn = page.locator("#btnSaveSettings");
    await expect(btn).toBeVisible();
    // After scrolling, the sticky button should still be inside the viewport.
    const inViewport = await btn.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    expect(inViewport).toBe(true);
  });
});
