import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Pending Leads — view loads + key affordances render", () => {
  test("navigating to /dashboard#leads renders the pending leads pane", async ({ page }) => {
    await page.goto("/dashboard#leads");

    // The leads pane should become visible. Loading indicator either resolves
    // to a leads table or to an empty-state — either is fine for smoke.
    await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 15_000 });

    // The body container is always present; we just wait for it to render.
    await expect(page.locator("#pendingLeadsBody")).toBeVisible({ timeout: 15_000 });

    // Auto-intake toggle (admin-gated) is part of the pane chrome.
    await expect(page.locator("#leadIntakeToggleWrap")).toBeVisible();
  });

  test("clicking + Create from list view routes to the leads pane", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

    // The Create button on the agent list header opens the pending-leads pane.
    await page.locator("#btnCreate").click();
    await expect(page.locator("#pendingLeadsView")).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain("#leads");
  });
});
