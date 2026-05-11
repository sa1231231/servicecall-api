import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Mobile pending-leads polish (≤768px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("leads list renders rows as block cards (thead hidden)", async ({ page }) => {
    await page.goto("/dashboard#leads");
    await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#pendingLeadsBody")).toBeVisible({ timeout: 15_000 });

    // Wait for either the list table OR an empty state to settle.
    await page.waitForFunction(
      () => {
        const body = document.getElementById("pendingLeadsBody");
        if (!body) return false;
        return !body.querySelector(".loading");
      },
      undefined,
      { timeout: 15_000 },
    );

    const rows = page.locator("#pendingLeadsBody tbody tr");
    const rowCount = await rows.count();
    test.skip(
      rowCount === 0,
      "No pending leads in production fixture — card layout asserts skipped",
    );

    // thead is hidden on mobile so cells aren't squeezed under headers.
    await expect(page.locator("#pendingLeadsBody thead")).not.toBeVisible();

    // The first row renders as a card (display: block) — confirm by checking
    // it occupies a width close to the viewport (would be much narrower if
    // table-cell layout had won).
    const firstRow = rows.first();
    const box = await firstRow.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(300);
  });

  test("dismiss button in a list card meets 44px tap target", async ({ page }) => {
    await page.goto("/dashboard#leads");
    await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 15_000 });

    const dismissBtns = page.locator(
      "#pendingLeadsBody tbody tr td:last-child button",
    );
    const count = await dismissBtns.count();
    test.skip(count === 0, "No pending leads to measure dismiss button on");

    const box = await dismissBtns.first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
