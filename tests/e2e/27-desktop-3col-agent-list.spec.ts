import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Desktop agent list — 2-column default (Q2)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test.beforeEach(async ({ page }) => {
    // Wipe any prior agentListState in localStorage so the test sees the
    // fresh-user default visibility (operators with v1 state get migrated;
    // we test the migrated-or-fresh state).
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("agentListState.v1");
        localStorage.removeItem("agentListState.v2");
      } catch {}
    });
  });

  test("default visible columns are Name + MTD COGS only", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(
      page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`),
    ).toBeVisible({ timeout: 15_000 });

    const headers = page.locator("#agentList thead th[data-col]");
    const visibleKeys = await headers.evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetWidth > 0)
        .map((el) => el.getAttribute("data-col")),
    );
    expect(visibleKeys).toEqual(["name", "mtd_cogs"]);
  });

  test("status badge renders inline inside the Name cell", async ({ page }) => {
    await page.goto("/dashboard");
    const row = page.locator(
      `#agentList tr.clickable-row[data-slug="${DEMO_METER.slug}"]`,
    );
    await expect(row).toBeVisible({ timeout: 15_000 });

    const inlineBadge = row.locator(
      'td[data-col="name"] .badge.badge-row-status',
    );
    await expect(inlineBadge).toBeVisible();
    await expect(inlineBadge).toContainText(/Live|Shadow|Disabled/);
  });

  test("hidden columns (Trial/Phone/Client) are still reachable via column picker", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("#agentList")).toBeVisible({ timeout: 15_000 });

    // Open the column picker — every column should appear as an option, even
    // if hidden by default. This confirms power users can still toggle them on.
    await page.locator("#columnPickerBtn").click();
    const menu = page.locator("#columnPickerMenu");
    await expect(menu).toBeVisible();
    for (const label of ["Trial", "Status", "Phone", "Client name"]) {
      await expect(menu).toContainText(label);
    }
  });
});
