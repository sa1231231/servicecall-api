import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Admin tab — read-only smoke (no send/mutate)", () => {
  test("SMS Blast editor renders and shows Send button (does not click)", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-settings-tab="admin"]').click();
    await expect(page.locator("#settings-tab-admin")).toHaveClass(/active/);

    // SMS Blast editor + send button render. We do NOT click Send.
    await expect(page.locator("#blast-message-editor")).toBeVisible();
    await expect(page.locator("#btnBlastSend")).toBeVisible();
  });

  test("User Management container resolves (loads list or empty state)", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    await page.locator('[data-settings-tab="admin"]').click();
    const container = page.locator("#userManagementContainer");
    await expect(container).toBeVisible({ timeout: 10_000 });

    // The "Loading..." placeholder should disappear when the API resolves.
    await expect(container.locator(".loading")).toHaveCount(0, { timeout: 15_000 });
  });
});
