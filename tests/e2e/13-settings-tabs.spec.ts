import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Global Settings — four config tabs load", () => {
  test("each settings tab activates its pane without errors", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    // After M2 the Admin tab moved to its own top-level view (/dashboard#admin),
    // so Settings now has just the four config-only tabs.
    const tabs: Array<{ key: string; sentinel: string }> = [
      { key: "general", sentinel: "#settings-owner-email" },
      { key: "templates", sentinel: "#settings-review-url" },
      { key: "costs", sentinel: "#settings-trial-days" },
      { key: "categories", sentinel: "#settings-tab-categories" },
    ];

    for (const { key, sentinel } of tabs) {
      await page.locator(`[data-settings-tab="${key}"]`).click();
      await expect(page.locator(`#settings-tab-${key}`)).toHaveClass(/active/, {
        timeout: 5_000,
      });
      await expect(page.locator(sentinel)).toBeVisible({ timeout: 5_000 });
    }

    // The Admin tab is gone from settings nav.
    await expect(page.locator('[data-settings-tab="admin"]')).toHaveCount(0);
  });
});
