import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, apiFetch, DEMO_METER } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("Create form — load + JSON import (no submit)", () => {
  test("form renders and importing Demo Meter's exported JSON populates the fields", async ({ page }) => {
    await page.goto("/form");

    // Form loads. The data-points dropdown populates after /form/data-points
    // returns; that's the slowest async load on this page.
    await expect(page.locator("#agentForm")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#businessName")).toBeVisible();

    // Pull a real exported config from the server so the import has shape
    // the form expects (saves us hand-maintaining a fixture).
    const exportResp = await apiFetch(env, `/dashboard/api/agents/${DEMO_METER.slug}/export`);
    expect(exportResp.status).toBe(200);
    const exported = await exportResp.json();

    // Load it via the file input (the form's loadFromJsonFile hook reads
    // input.files[0] and applies it).
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo-meter-config.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });

    // After import, businessName should be populated.
    await expect(page.locator("#businessName")).toHaveValue(/.+/, { timeout: 10_000 });

    // Make sure something loaded — the imported business name should match
    // what the export returned.
    const expectedName = exported?.business?.businessName ?? "";
    if (expectedName) {
      await expect(page.locator("#businessName")).toHaveValue(expectedName);
    }
  });

  test("form serves /form/config and /form/data-points successfully", async ({ page }) => {
    await page.goto("/form");

    const config = await page.request.get("/form/config");
    expect(config.status()).toBe(200);
    expect((await config.json()).apiKey).toBeDefined();

    const dp = await page.request.get("/form/data-points");
    expect(dp.status()).toBe(200);
  });
});
