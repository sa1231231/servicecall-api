import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, apiGet, apiPatch, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

interface AgentDoc {
  shadow_mode?: boolean;
}

test.describe("Shadow mode toggle — UI flips state and persists", () => {
  let originalShadowMode: boolean | undefined;

  test.beforeAll(async () => {
    // Capture original so afterAll can restore it.
    const doc = await apiGet<AgentDoc>(env, `/dashboard/api/agents/${DEMO_METER.slug}`);
    originalShadowMode = doc.shadow_mode;
  });

  test.afterAll(async () => {
    // Restore. Skip if we never read original (e.g. beforeAll failed).
    if (typeof originalShadowMode !== "boolean") return;
    await apiPatch(env, `/dashboard/api/agents/${DEMO_METER.slug}/shadow`, {
      shadow_mode: originalShadowMode,
    });
  });

  test("clicking the shadow toggle in the dashboard row flips the DB value", async ({ page }) => {
    await page.goto("/dashboard");

    // Wait for agents list to populate.
    const row = page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Find the shadow checkbox inside the row. The row has TWO toggles
    // (active + shadow); we identify the shadow one by its onchange handler.
    const shadowCheckbox = row.locator('input[onchange*="toggleShadow"]');
    await expect(shadowCheckbox).toBeVisible();

    const before = await shadowCheckbox.isChecked();

    // Click the surrounding label rather than the checkbox itself — the
    // toggle UI is a slider where the input is `display:none`-ish but
    // still bound to the click via the wrapping <label>.
    const toggleLabel = shadowCheckbox.locator("xpath=ancestor::label[1]");
    await toggleLabel.click();

    // Wait for the toast confirmation that toggleShadow's PATCH succeeded.
    await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });

    // Verify checkbox state inverted in the DOM.
    await expect(shadowCheckbox).toBeChecked({ checked: !before, timeout: 5_000 });

    // Verify in MongoDB by re-reading via the API.
    const doc = await apiGet<AgentDoc>(env, `/dashboard/api/agents/${DEMO_METER.slug}`);
    expect(doc.shadow_mode).toBe(!before);
  });
});
