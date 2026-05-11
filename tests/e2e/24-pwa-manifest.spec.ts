import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

test.describe("PWA — manifest + meta tags", () => {
  test("manifest is served from /assets/manifest.json with required fields", async ({ page }) => {
    const resp = await page.request.get("/assets/manifest.json");
    expect(resp.status()).toBe(200);
    const m = await resp.json();
    expect(m.name).toBeTruthy();
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe("/dashboard");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toBe("#2563eb");
  });

  test("dashboard.html declares the manifest and PWA meta tags", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("#listView")).toBeVisible({ timeout: 15_000 });

    // <link rel="manifest"> wires the manifest into the page.
    const manifestHref = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    expect(manifestHref).toBe("/assets/manifest.json");

    // Required iOS standalone-mode meta tag.
    const iosCapable = await page
      .locator('meta[name="apple-mobile-web-app-capable"]')
      .getAttribute("content");
    expect(iosCapable).toBe("yes");

    // Theme color (used by Safari/Chrome mobile chrome bar).
    const themeColor = await page
      .locator('meta[name="theme-color"]')
      .getAttribute("content");
    expect(themeColor).toBe("#2563eb");
  });
});
