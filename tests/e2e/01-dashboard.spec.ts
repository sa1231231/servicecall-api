import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Dashboard — login + agent list", () => {
  test("admin can load /dashboard and sees the test agent in the agents list", async ({ page }) => {
    // Navigate. extraHTTPHeaders pre-supplies Basic Auth so the browser
    // dialog never appears.
    await page.goto("/dashboard");

    // The agents table is fetched async after DOMContentLoaded. Wait for
    // the loading placeholder to disappear and the demo-hvac row to appear.
    await expect(
      page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    // Sanity: the row contains agent name text
    const row = page.locator(`[data-slug="${TEST_AGENT.slug}"]`);
    await expect(row).toContainText(/Demo (Meter|Team)/i);
  });

});
