import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Mobile agent search button", () => {
  test.describe("at iPhone viewport (375x667)", () => {
    test.use({ viewport: { width: 375, height: 667 } });

    test("search button is visible and 44px tap target", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

      const btn = page.locator("#btnMobileSearch");
      await expect(btn).toBeVisible();
      const box = await btn.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    });

    test("tapping the button opens the Cmd+K palette", async ({ page }) => {
      await page.goto("/dashboard");
      // Wait for agentRows to populate — openCommandPalette is a no-op when empty.
      await expect(page.locator("#agentList tr.clickable-row").first()).toBeVisible({
        timeout: 15_000,
      });

      await page.locator("#btnMobileSearch").click();
      await expect(page.locator("#commandPaletteOverlay")).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.locator("#cmdPaletteInput")).toBeFocused();
    });
  });

  test.describe("at desktop viewport (1280x800)", () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test("search button is hidden on desktop (Cmd+K covers it)", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });
      const isHidden = await page.locator("#btnMobileSearch").evaluate(
        (el) => window.getComputedStyle(el).display === "none",
      );
      expect(isHidden).toBe(true);
    });
  });
});
