import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Browser back/forward — pushState navigation", () => {
  test("back/forward toggles between agent detail and the list", async ({ page }) => {
    await page.goto("/dashboard");

    const row = page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Open the test agent — pushes #agent=demo-hvac onto the history stack.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/dashboard/api/agents/${TEST_AGENT.slug}`) &&
          r.request().method() === "GET",
        { timeout: 15_000 },
      ),
      row.click(),
    ]);
    await expect(page.locator("#detailView")).toBeVisible();
    expect(page.url()).toContain(`#agent=${TEST_AGENT.slug}`);

    // "Back to all agents" — pushes the bare /dashboard URL.
    await page.locator('#detailView .btn-back').first().click();
    await expect(page.locator("#listView")).toBeVisible();
    await expect(page.locator("#detailView")).toBeHidden();
    expect(page.url()).not.toContain("#agent=");

    // Browser back — popstate handler should restore the agent detail view.
    await page.goBack();
    await expect(page.locator("#detailView")).toBeVisible();
    await expect(page.locator("#listView")).toBeHidden();
    expect(page.url()).toContain(`#agent=${TEST_AGENT.slug}`);

    // Browser forward — popstate handler should return to the list.
    await page.goForward();
    await expect(page.locator("#listView")).toBeVisible();
    await expect(page.locator("#detailView")).toBeHidden();
    expect(page.url()).not.toContain("#agent=");
  });
});
