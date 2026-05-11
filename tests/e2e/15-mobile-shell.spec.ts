import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Mobile shell — bottom tab bar (≤768px)", () => {
  test.describe("at iPhone viewport (375x667)", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("bottom tab bar is visible with 4 tabs", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      const bar = page.locator(".mobile-tab-bar");
      await expect(bar).toBeVisible();

      const tabs = bar.locator(".mobile-tab");
      await expect(tabs).toHaveCount(4);
      await expect(tabs.nth(0)).toContainText("Agents");
      await expect(tabs.nth(1)).toContainText("Inbox");
      await expect(tabs.nth(2)).toContainText("Settings");
      await expect(tabs.nth(3)).toContainText("Sign out");
    });

    test("tapping Inbox opens the pending leads pane", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      await page.locator('.mobile-tab[data-tab="inbox"]').click();
      await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 10_000 });

      // Active state should track the URL.
      await expect(page.locator('.mobile-tab[data-tab="inbox"]')).toHaveClass(
        /active/,
      );
    });

    test("tapping Settings opens the global settings pane", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      await page.locator('.mobile-tab[data-tab="settings"]').click();
      await expect(page.locator("#settingsView")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.mobile-tab[data-tab="settings"]')).toHaveClass(
        /active/,
      );
    });

    test("tabs meet 44px minimum height for tap targets", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator(".mobile-tab-bar")).toBeVisible({ timeout: 15_000 });

      const box = await page.locator('.mobile-tab[data-tab="agents"]').boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    });
  });

  test.describe("at desktop viewport (1280x800)", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("bottom tab bar is hidden on desktop", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      // CSS hides it via display:none; toBeVisible() returns false.
      await expect(page.locator(".mobile-tab-bar")).not.toBeVisible();
    });
  });
});
