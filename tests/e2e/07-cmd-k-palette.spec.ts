import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Cmd+K agent quick-switcher", () => {
  test("opens with Ctrl+K, filters by typing, and Enter opens the highlighted agent", async ({ page }) => {
    await page.goto("/dashboard");

    // Wait for the agent list to populate so `agentRows` is non-empty;
    // openCommandPalette() bails out otherwise.
    await expect(
      page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    // The dashboard's keydown handler accepts both metaKey and ctrlKey, so
    // Control+K works on Linux CI without needing platform branching.
    await page.keyboard.press("Control+K");

    const overlay = page.locator("#commandPaletteOverlay");
    await expect(overlay).toBeVisible();

    const input = page.locator("#cmdPaletteInput");
    await expect(input).toBeFocused();

    // Type "demo" — the test agent should match by name (and "demo-hvac" by slug).
    await input.fill("demo");
    const demoResult = page.locator(
      `#cmdPaletteResults li:has-text("${TEST_AGENT.slug}")`,
    );
    await expect(demoResult).toBeVisible();
    // First result is auto-active.
    await expect(demoResult.first()).toHaveClass(/active/);

    // Pressing Enter on the highlighted result should navigate to the agent.
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/dashboard/api/agents/${TEST_AGENT.slug}`) &&
          r.request().method() === "GET",
        { timeout: 15_000 },
      ),
      page.keyboard.press("Enter"),
    ]);

    // Palette is closed and the detail view is visible with the right hash.
    await expect(overlay).toBeHidden();
    await expect(page.locator("#detailView")).toBeVisible();
    expect(page.url()).toContain(`#agent=${TEST_AGENT.slug}`);
  });

  test("Escape closes the palette without navigating", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${TEST_AGENT.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    const startUrl = page.url();

    await page.keyboard.press("Control+K");
    await expect(page.locator("#commandPaletteOverlay")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#commandPaletteOverlay")).toBeHidden();

    // Still on the list; no hash change.
    await expect(page.locator("#listView")).toBeVisible();
    expect(page.url()).toBe(startUrl);
  });
});
