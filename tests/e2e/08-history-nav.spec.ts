import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Browser back/forward — pushState navigation", () => {
  test("back/forward toggles between agent detail and the list", async ({ page }) => {
    await page.goto("/dashboard");

    const row = page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Open Demo Meter — pushes #agent=demo-meter onto the history stack.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/dashboard/api/agents/${DEMO_METER.slug}`) &&
          r.request().method() === "GET",
        { timeout: 15_000 },
      ),
      row.click(),
    ]);
    await expect(page.locator("#detailView")).toBeVisible();
    expect(page.url()).toContain(`#agent=${DEMO_METER.slug}`);

    // "Back to all agents" — pushes the bare /dashboard URL.
    await page.locator('#detailView .btn-back').first().click();
    await expect(page.locator("#listView")).toBeVisible();
    await expect(page.locator("#detailView")).toBeHidden();
    expect(page.url()).not.toContain("#agent=");

    // Browser back — popstate handler should restore the agent detail view.
    await page.goBack();
    await expect(page.locator("#detailView")).toBeVisible();
    await expect(page.locator("#listView")).toBeHidden();
    expect(page.url()).toContain(`#agent=${DEMO_METER.slug}`);

    // Browser forward — popstate handler should return to the list.
    await page.goForward();
    await expect(page.locator("#listView")).toBeVisible();
    await expect(page.locator("#detailView")).toBeHidden();
    expect(page.url()).not.toContain("#agent=");
  });
});
