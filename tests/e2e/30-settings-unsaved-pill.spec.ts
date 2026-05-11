import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Settings — Unsaved pill (Q5)", () => {
  test("pill starts hidden, appears on edit, hides on (would-be) save", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

    const pill = page.locator("#settingsUnsavedPill");
    await expect(pill).toBeAttached();
    // After load + populate, pill is hidden.
    await expect(pill).toBeHidden();

    // Edit a benign field — owner email — should flip the pill on.
    const emailInput = page.locator("#settings-owner-email");
    await emailInput.click();
    const originalEmail = await emailInput.inputValue();
    await emailInput.fill(originalEmail + " ");
    await expect(pill).toBeVisible();

    // Revert so we don't leave dirty state behind. Production has no
    // mutation safeguard via this test path, so we don't click Save.
    await emailInput.fill(originalEmail);
  });

  test("Setup Instructions inline save renders as a subordinate (outline) button", async ({ page }) => {
    await page.goto("/dashboard#settings");
    await page.locator('[data-settings-tab="templates"]').click();
    const inlineSave = page.locator("#btnSaveInstructions");
    await expect(inlineSave).toBeVisible({ timeout: 10_000 });
    // The class drives the new outline-style; presence is the assertion.
    await expect(inlineSave).toHaveClass(/btn-section-save/);
  });
});
