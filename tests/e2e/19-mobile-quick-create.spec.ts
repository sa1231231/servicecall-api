import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Quick Create form on mobile (≤768px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("primary inputs hit 44px tap targets and 16px font (no iOS zoom)", async ({ page }) => {
    await page.goto("/quick-create");
    await expect(page.locator("#quickCreateForm")).toBeVisible({ timeout: 15_000 });

    for (const selector of ["#businessName", "#draftSelect"]) {
      const el = page.locator(selector);
      const box = await el.boundingBox();
      expect(box, `${selector} bounding box`).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);

      // 16px (1rem) prevents iOS Safari from auto-zooming on focus.
      const fontSizePx = await el.evaluate(
        (n) => parseFloat(window.getComputedStyle(n).fontSize) || 0,
      );
      expect(fontSizePx).toBeGreaterThanOrEqual(16);
    }
  });

  test("Create Agent button is full-width and 44px tall", async ({ page }) => {
    await page.goto("/quick-create");
    await expect(page.locator("#btnCreate")).toBeVisible({ timeout: 15_000 });

    const box = await page.locator("#btnCreate").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // Full-width on mobile means the button spans most of the form card.
    const cardBox = await page.locator(".card").boundingBox();
    expect(cardBox).not.toBeNull();
    expect(box!.width).toBeGreaterThan(cardBox!.width - 60);
  });
});
