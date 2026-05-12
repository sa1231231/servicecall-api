import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Desktop left nav rail (M1)", () => {
  test.describe("at desktop viewport (1280x800)", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("rail is visible with Agents/Inbox/Settings/Admin", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#leftRail")).toBeVisible({ timeout: 15_000 });

      for (const key of ["agents", "inbox", "settings", "admin"]) {
        await expect(page.locator(`.left-rail-item[data-rail="${key}"]`)).toBeVisible();
      }

      // Default active state matches the current view (agent list = agents).
      await expect(page.locator('.left-rail-item[data-rail="agents"]')).toHaveClass(
        /active/,
      );
    });

    test("clicking Inbox routes to leads and lights up the rail item", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#leftRail")).toBeVisible({ timeout: 15_000 });

      await page.locator('.left-rail-item[data-rail="inbox"]').click();
      await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.left-rail-item[data-rail="inbox"]')).toHaveClass(/active/);
      expect(page.url()).toContain("#leads");
    });

    test("clicking Settings opens global settings and lights up the rail item", async ({ page }) => {
      await page.goto("/dashboard");
      await page.locator('.left-rail-item[data-rail="settings"]').click();
      await expect(page.locator("#settingsView")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.left-rail-item[data-rail="settings"]')).toHaveClass(/active/);
    });
  });

  test.describe("at mobile viewport (375x667)", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("rail is hidden on mobile", async ({ page }) => {
      await page.goto("/dashboard");
      const isHidden = await page.locator("#leftRail").evaluate(
        (el) => window.getComputedStyle(el).display === "none",
      );
      expect(isHidden).toBe(true);
    });
  });
});
