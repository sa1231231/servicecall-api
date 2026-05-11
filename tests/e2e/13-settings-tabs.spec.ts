import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Global Settings — all five tabs load", () => {
  test("each settings tab activates its pane without errors", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    // Tab labels and the id of one input expected to render in each pane.
    const tabs: Array<{ key: string; sentinel: string }> = [
      { key: "general", sentinel: "#settings-owner-email" },
      { key: "templates", sentinel: "#settings-review-url" },
      { key: "costs", sentinel: "#settings-trial-days" },
      { key: "categories", sentinel: "#settings-tab-categories" },
      { key: "admin", sentinel: "#blast-message-editor" },
    ];

    for (const { key, sentinel } of tabs) {
      await page.locator(`[data-settings-tab="${key}"]`).click();
      await expect(page.locator(`#settings-tab-${key}`)).toHaveClass(/active/, {
        timeout: 5_000,
      });
      await expect(page.locator(sentinel)).toBeVisible({ timeout: 5_000 });
    }
  });
});
