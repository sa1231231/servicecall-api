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
    const doc = await apiGet<AgentDoc>(env, `/dashboard/api/agents/${DEMO_METER.slug}`);
    originalShadowMode = doc.shadow_mode;
  });

  test.afterAll(async () => {
    if (typeof originalShadowMode !== "boolean") return;
    await apiPatch(env, `/dashboard/api/agents/${DEMO_METER.slug}/shadow`, {
      shadow_mode: originalShadowMode,
    });
  });

  test("flipping shadow mode in the agent detail Settings tab persists to the DB", async ({ page }) => {
    await page.goto("/dashboard");

    // Wait for the agent list to populate, then click the demo-meter row.
    // The row is the click target — `agentRowClick` calls `showDetail(slug)`
    // which renders the detail view with the Settings tab active by default.
    const row = page.locator(`#agentList [data-slug="${DEMO_METER.slug}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // Settings tab is the default; scope everything to the agent-detail
    // Settings pane since the workspace-level Settings page also has a
    // #btnSaveSettings button living elsewhere in the DOM.
    const settingsPane = page.locator("#tab-settings");
    const shadowCheckbox = settingsPane.locator("#edit-shadow-mode");
    await expect(shadowCheckbox).toBeAttached({ timeout: 10_000 });

    const before = await shadowCheckbox.isChecked();

    // The <input> is visually hidden by the toggle CSS; click the wrapping
    // <label class="toggle"> instead.
    const toggleLabel = shadowCheckbox.locator("xpath=ancestor::label[1]");
    await toggleLabel.click();
    await expect(shadowCheckbox).toBeChecked({ checked: !before, timeout: 5_000 });

    // Save and wait for the toast confirmation that the PATCH succeeded.
    await settingsPane.locator("#btnSaveSettings").click();
    await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });

    // Verify the DB picked up the change via the API.
    const doc = await apiGet<AgentDoc>(env, `/dashboard/api/agents/${DEMO_METER.slug}`);
    expect(doc.shadow_mode).toBe(!before);
  });
});
