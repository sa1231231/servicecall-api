import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Agent detail tab dots (Q6)", () => {
  test("Nodes tab dot exists and starts hidden on the test agent", async ({ page }) => {
    await page.goto("/dashboard");
    const row = page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.locator("#detailView")).toBeVisible({ timeout: 10_000 });

    // The dot exists in the DOM — its hidden attribute is toggled by
    // renderDetail() based on doc.drift_detected_at. the test agent typically
    // does not have active drift, so the dot starts hidden.
    const dot = page.locator("#nodesTabDot");
    await expect(dot).toHaveCount(1);
    const isHidden = await dot.evaluate((el) => el.hasAttribute("hidden"));
    expect(isHidden).toBe(true);
  });
});
