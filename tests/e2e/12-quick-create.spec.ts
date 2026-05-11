import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Quick Create — page loads", () => {
  test("/quick-create renders the one-page form", async ({ page }) => {
    await page.goto("/quick-create");
    await expect(page.locator("#quickCreateForm")).toBeVisible({ timeout: 15_000 });
  });
});
