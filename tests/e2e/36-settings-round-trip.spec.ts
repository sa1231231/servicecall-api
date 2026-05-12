import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, apiGet, apiPatch } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

interface Settings {
  owner_phone?: string;
  owner_email?: string;
  [k: string]: unknown;
}

// Mutates a benign settings field via the real UI, verifies persistence
// after a reload, then reverts. This is the only e2e test that drives the
// PATCH /dashboard/api/settings path through real UI clicks. The unit
// tests cover the server side; the existing settings-tabs.spec.ts covers
// "tabs load" but not save persistence.
test.describe("Settings save round-trip (UI → API → reload)", () => {
  test("editing owner_phone, saving, and reloading persists the change", async ({ page }) => {
    // Capture the current value via the API so we can restore it at the end.
    const before = await apiGet<Settings>(env, "/dashboard/api/settings");
    const originalPhone = (before.owner_phone as string | undefined) ?? "";
    // Use a clearly-synthetic placeholder so manual inspection of prod
    // settings between runs sees obvious test residue (the finally-block
    // reverts, but belt + suspenders).
    const sentinel = "+15555550199";

    try {
      await page.goto("/dashboard#settings");
      await expect(page.locator("#settingsView")).toBeVisible({ timeout: 15_000 });

      // Wait for the form to populate from /dashboard/api/settings.
      await expect(page.locator("#settings-owner-phone")).toBeAttached({ timeout: 10_000 });
      await page.waitForFunction(() => {
        const el = document.getElementById("settings-owner-phone") as HTMLInputElement | null;
        // Either populated with the existing value or rendered with an empty
        // input — both signal the loader finished.
        return el !== null && el.placeholder !== undefined;
      });

      const phoneInput = page.locator("#settings-owner-phone");
      await phoneInput.fill(sentinel);

      // Save → wait for the API PATCH to return + the success toast.
      const [resp] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith("/dashboard/api/settings") && r.request().method() === "PATCH",
          { timeout: 15_000 },
        ),
        page.locator("#btnSaveSettings").click(),
      ]);
      expect(resp.ok()).toBe(true);

      // Reload from a different view to be sure the value is server-side.
      await page.goto("/dashboard");
      await expect(page.locator("#listView")).toBeVisible({ timeout: 10_000 });
      await page.goto("/dashboard#settings");
      await expect(page.locator("#settings-owner-phone")).toHaveValue(sentinel, {
        timeout: 10_000,
      });
    } finally {
      // Revert via the API regardless of pass/fail so we never leave a test
      // sentinel sitting in production settings.
      await apiPatch(env, "/dashboard/api/settings", {
        owner_phone: originalPhone,
      });
    }
  });
});
