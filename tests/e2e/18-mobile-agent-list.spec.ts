import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Agent list on mobile (≤768px)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("agent rows render as block cards (thead hidden)", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    // thead is hidden on mobile.
    await expect(page.locator("#agentList thead")).not.toBeVisible();

    // The the test agent row should be a block-level card occupying ~the full
    // viewport width (a table-cell row would be much narrower than 300px
    // even with overflow).
    const row = page.locator(
      `#agentList tr.clickable-row[data-slug="${TEST_AGENT.slug}"]`,
    );
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(300);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("phone + contact_name are not in the DOM (hidden by default column visibility)", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    const row = page.locator(
      `#agentList tr.clickable-row[data-slug="${TEST_AGENT.slug}"]`,
    );
    // After Q2: phone and contact_name are off by default (and renderAgentRow
    // skips hidden columns entirely), so no <td data-col="phone"> exists.
    for (const col of ["phone", "contact_name"]) {
      const count = await row.locator(`td[data-col="${col}"]`).count();
      expect(count, `col ${col} should not be rendered when hidden`).toBe(0);
    }
  });

  test("name cell + inline status badge are visible; mtd_cogs row also shown", async ({ page }) => {
    await page.goto("/dashboard");
    const row = page.locator(
      `#agentList tr.clickable-row[data-slug="${TEST_AGENT.slug}"]`,
    );
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('td[data-col="name"]')).toBeVisible();
    // Status moved inline into the Name cell (Q2). The dedicated Status td
    // is hidden by default; verify the inline badge is rendered instead.
    await expect(row.locator('td[data-col="name"] .badge-row-status')).toBeVisible();
    // Cost stays visible on mobile cards too — it's the primary scan metric.
    await expect(row.locator('td[data-col="mtd_cogs"]')).toBeVisible();
  });
});
