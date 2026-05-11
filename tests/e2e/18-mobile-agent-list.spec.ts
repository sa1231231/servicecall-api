import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Agent list on mobile (≤768px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("agent rows render as block cards (thead hidden)", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    // thead is hidden on mobile.
    await expect(page.locator("#agentList thead")).not.toBeVisible();

    // The Demo Meter row should be a block-level card occupying ~the full
    // viewport width (a table-cell row would be much narrower than 300px
    // even with overflow).
    const row = page.locator(
      `#agentList tr.clickable-row[data-slug="${DEMO_METER.slug}"]`,
    );
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(300);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("secondary columns (mtd_cogs, phone, contact_name) are hidden", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.locator(
      `#agentList tr.clickable-row[data-slug="${DEMO_METER.slug}"]`,
    );
    // Each of these cells should be display:none. Use evaluate to verify
    // since toBeHidden also passes for visibility-hidden + zero-sized.
    for (const col of ["mtd_cogs", "phone", "contact_name"]) {
      const isHidden = await row.locator(`td[data-col="${col}"]`).evaluate(
        (el) => window.getComputedStyle(el).display === "none",
      );
      expect(isHidden, `col ${col} should be hidden on mobile`).toBe(true);
    }
  });

  test("name + status columns are visible", async ({ page }) => {
    await page.goto("/dashboard");
    const row = page.locator(
      `#agentList tr.clickable-row[data-slug="${DEMO_METER.slug}"]`,
    );
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('td[data-col="name"]')).toBeVisible();
    await expect(row.locator('td[data-col="status"]')).toBeVisible();
  });
});
