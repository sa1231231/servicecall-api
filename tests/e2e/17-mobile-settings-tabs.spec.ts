import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Settings tabs on mobile (≤768px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("settings tabs meet 44px tap targets", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    const generalTab = page.locator(
      '#settingsView [data-settings-tab="general"]',
    );
    await expect(generalTab).toBeVisible();
    const box = await generalTab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("settings tabs nav is sticky-positioned at the top of the settings pane", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    const navPositionVal = await page.evaluate(() => {
      const nav = document.querySelector(
        "#settingsView .agent-tabs-nav",
      ) as HTMLElement | null;
      if (!nav) return null;
      return window.getComputedStyle(nav).position;
    });
    expect(navPositionVal).toBe("sticky");
  });
});
