import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Tab preservation across agent navigation", () => {
  test("opening an agent without an explicit tab in the URL re-uses the previously active tab", async ({ page }) => {
    await page.goto("/dashboard");

    const row = page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // 1. Open Demo Meter — defaults to the Settings tab on first navigation.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/dashboard/api/agents/${DEMO_METER.slug}`) &&
          r.request().method() === "GET",
        { timeout: 15_000 },
      ),
      row.click(),
    ]);
    await expect(page.locator('button.agent-tab[data-tab="settings"]')).toHaveClass(/active/);

    // 2. Switch to the Billing tab — URL hash should now carry &tab=billing
    //    and activeTab in JS should be "billing".
    await page.locator('button.agent-tab[data-tab="billing"]').click();
    await expect(page.locator('button.agent-tab[data-tab="billing"]')).toHaveClass(/active/);
    expect(page.url()).toContain("&tab=billing");

    // 3. Go back to the agent list (clears the hash entirely).
    await page.locator('#detailView .btn-back').first().click();
    await expect(page.locator("#listView")).toBeVisible();
    expect(page.url()).not.toContain("#agent=");

    // 4. Click the same agent again. The URL has no &tab= so showDetail()
    //    should fall back to the still-set activeTab ("billing"), not reset
    //    to "settings". This is the regression we're guarding.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/dashboard/api/agents/${DEMO_METER.slug}`) &&
          r.request().method() === "GET",
        { timeout: 15_000 },
      ),
      row.click(),
    ]);

    await expect(page.locator('button.agent-tab[data-tab="billing"]')).toHaveClass(/active/);
    await expect(page.locator('button.agent-tab[data-tab="settings"]')).not.toHaveClass(/active/);
    expect(page.url()).toContain("&tab=billing");
  });
});
