import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Admin pulled out of Settings (M2)", () => {
  test("Settings nav no longer shows the Admin tab button", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });
    // The Admin button used to live in the settings tabs nav.
    await expect(page.locator('[data-settings-tab="admin"]')).toHaveCount(0);
  });

  test("/dashboard#admin renders the standalone Admin view with SMS Blast + Users", async ({ page }) => {
    await page.goto("/dashboard#admin");
    await expect(page.locator("#adminView")).toBeVisible({ timeout: 15_000 });

    // Sentinel elements that used to live inside settings-tab-admin now
    // live under #adminView. Their IDs are unchanged.
    await expect(page.locator("#blast-message-editor")).toBeVisible();
    // The user management container is gated by super-admin role. When the
    // test user IS root/super-admin (E2E_USER=admin via ROOT_PASSWORD), it
    // renders; otherwise the section is hidden. Either is fine here — we
    // assert visibility of the always-visible SMS Blast bit.
  });

  test("user menu (desktop) carries an Admin entry that routes to #admin", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/dashboard");
    await expect(page.locator("#userMenuBtn")).toBeVisible({ timeout: 15_000 });
    await page.locator("#userMenuBtn").click();
    const pop = page.locator("#userMenuPopover");
    await expect(pop).toBeVisible();
    // Admin item is admin-only — at desktop the admin user can see it.
    // Use the role+name selector — the user-menu also shows the literal
    // username "admin" elsewhere in the popover, so text=Admin is ambiguous.
    const adminItem = pop.getByRole('menuitem', { name: 'Admin' });
    await expect(adminItem).toBeVisible();
    await adminItem.click();
    await expect(page.locator("#adminView")).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain("#admin");
  });
});
