import { test, expect } from "@playwright/test";
import { getEnv, apiFetch, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

interface PortalTokenResp {
  has_token?: boolean;
  portal_url?: string | null;
  success?: boolean;
}

test.describe("Portal — token auth + dispatch view", () => {
  let portalUrl: string;

  test.beforeAll(async () => {
    // Idempotent: GET first, POST only if no token exists.
    let resp = await apiFetch(env, `/dashboard/api/agents/${TEST_AGENT.slug}/portal-token`);
    let body = (await resp.json()) as PortalTokenResp;

    if (!body.portal_url) {
      resp = await apiFetch(env, `/dashboard/api/agents/${TEST_AGENT.slug}/portal-token`, {
        method: "POST",
      });
      body = (await resp.json()) as PortalTokenResp;
    }

    if (!body.portal_url) {
      throw new Error("Could not obtain portal URL for the test agent");
    }
    portalUrl = body.portal_url;
  });

  test("portal loads, shows agent config, no Basic Auth required", async ({ page }) => {
    // No extraHTTPHeaders — portal uses token-only auth via query param.
    // The portalUrl already includes ?token=...
    await page.goto(portalUrl);

    // #content visible == auth succeeded; #authError visible == failed.
    await expect(page.locator("#content")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#authError")).not.toBeVisible();

    // The dispatch tab is the default visible pane.
    await expect(page.locator("#portal-tab-dispatch")).toBeVisible();
  });

  test("clicking the Activity tab lazy-loads call stats and call log", async ({ page }) => {
    await page.goto(portalUrl);
    await expect(page.locator("#content")).toBeVisible({ timeout: 15_000 });

    // The portal merged Analytics + Call Log into a single "Activity" tab.
    await page.locator('.portal-tab[data-tab="activity"]').click();

    // Stats row should populate. (Even if zero calls, the row renders with
    // a "Calculating..." placeholder, then resolves — we just check it's visible.)
    await expect(page.locator("#statsRow")).toBeVisible({ timeout: 15_000 });
    // The activity tab also includes a call log section.
    await expect(page.locator("#callSearch")).toBeVisible();
  });
});
