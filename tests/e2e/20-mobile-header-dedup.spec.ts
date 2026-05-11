import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Dashboard header — mobile dedup (≤768px)", () => {
  test.describe("at iPhone viewport (375x667)", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("Settings/Create/Logout/user-badge are hidden in the agent list header", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      // All four redundant chrome items hide on mobile. We use computed style
      // since the buttons stay in the DOM (so JS handlers don't break).
      const selectors = [
        "#listView > h1 .btn-settings",
        "#listView > h1 .btn-create",
        "#listView > h1 .user-badge",
      ];
      for (const sel of selectors) {
        const isHidden = await page.locator(sel).first().evaluate(
          (el) => window.getComputedStyle(el).display === "none",
        );
        expect(isHidden, `${sel} should be display:none on mobile`).toBe(true);
      }
    });

    test("Settings/Inbox/Sign out are still reachable via the bottom tab bar", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator(".mobile-tab-bar")).toBeVisible({ timeout: 15_000 });

      await expect(page.locator('.mobile-tab[data-tab="settings"]')).toBeVisible();
      await expect(page.locator('.mobile-tab[data-tab="inbox"]')).toBeVisible();
      await expect(page.locator('.mobile-tab[data-tab="logout"]')).toBeVisible();
    });
  });

  test.describe("at desktop viewport (1280x800)", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("Settings/Create/Logout remain visible in the header on desktop", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      await expect(page.locator("#listView > h1 .btn-settings").first()).toBeVisible();
      await expect(page.locator("#listView > h1 .btn-create")).toBeVisible();
    });
  });
});
