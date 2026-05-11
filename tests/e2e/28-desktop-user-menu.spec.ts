import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Desktop user menu — header dedup (Q1)", () => {
  test.describe("at desktop viewport (1280x800)", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("legacy header chrome (Settings/Logout/user-badge) is hidden; user-menu shown", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      // Settings button + Logout button + username badge all hide on desktop.
      for (const sel of [
        "#listView > h1 .btn-settings",
        "#listView > h1 .user-badge",
      ]) {
        const isHidden = await page.locator(sel).first().evaluate(
          (el) => window.getComputedStyle(el).display === "none",
        );
        expect(isHidden, `${sel} should be display:none on desktop`).toBe(true);
      }

      // The kebab user menu is visible in place of the chrome.
      await expect(page.locator("#userMenuBtn")).toBeVisible();
      // + Create stays as the primary CTA.
      await expect(page.locator("#btnCreate")).toBeVisible();
    });

    test("clicking the kebab opens the popover with Settings + Sign out", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#userMenuBtn")).toBeVisible({ timeout: 15_000 });

      await page.locator("#userMenuBtn").click();
      const pop = page.locator("#userMenuPopover");
      await expect(pop).toBeVisible();
      await expect(pop).toContainText("Settings");
      await expect(pop).toContainText("Sign out");

      // Identity is populated with the logged-in user.
      const name = await page.locator("#userMenuName").textContent();
      expect(name?.trim().length).toBeGreaterThan(0);

      // Esc closes the popover.
      await page.keyboard.press("Escape");
      await expect(pop).toBeHidden();
    });

    test("clicking Settings in the popover opens the global settings view", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#userMenuBtn")).toBeVisible({ timeout: 15_000 });

      await page.locator("#userMenuBtn").click();
      await page.locator('#userMenuPopover .user-menu-item').first().click();
      await expect(page.locator("#settingsView")).toBeVisible({ timeout: 10_000 });
    });
  });

  test.describe("at mobile viewport (375x667)", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("user-menu is hidden on mobile (mobile-tab-bar covers Settings + Sign out)", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      const isHidden = await page.locator("#userMenuWrap").evaluate(
        (el) => window.getComputedStyle(el).display === "none",
      );
      expect(isHidden).toBe(true);
    });
  });
});
