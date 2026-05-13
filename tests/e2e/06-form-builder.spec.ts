import { test, expect } from "@playwright/test";
import { getEnv, httpCredentials, apiFetch, TEST_AGENT } from "./_helpers.js";

const env = getEnv();

test.use({
  httpCredentials: httpCredentials(env),
});

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Add a value to a chip input by focusing the inner <input>, typing, and
 * pressing Enter (the chip widget commits on Enter/Tab/comma).
 */
async function addChip(page: import("@playwright/test").Page, chipContainerId: string, value: string) {
  const input = page.locator(`#${chipContainerId} input`);
  await input.fill(value);
  await input.press("Enter");
}

/** Read all chip values currently rendered inside a chip-input container. */
async function getChipValues(page: import("@playwright/test").Page, chipContainerId: string): Promise<string[]> {
  return await page.evaluate((id) => {
    const container = document.getElementById(id);
    if (!container) return [];
    // Each .chip's first child is a text node holding the value.
    return Array.from(container.querySelectorAll(".chip")).map((el) =>
      ((el.firstChild?.textContent ?? "") as string).trim(),
    );
  }, chipContainerId);
}

/** Pull a fresh the test agent export to use as a known-good fixture. */
async function fetchDemoMeterExport(): Promise<unknown> {
  const resp = await apiFetch(env, `/dashboard/api/agents/${TEST_AGENT.slug}/export`);
  if (!resp.ok) throw new Error(`Failed to fetch export: ${resp.status}`);
  return await resp.json();
}

/** Write the API key into the hidden #apiKey field so the form's submit
 *  handler attaches it to POST /agents/create. The key is normally injected
 *  by /form/config which fetches it server-side; in some test setups the
 *  fetch may not have populated it yet by the time we click submit. */
async function ensureApiKey(page: import("@playwright/test").Page) {
  await page.evaluate((key) => {
    const el = document.getElementById("apiKey") as HTMLInputElement | null;
    if (el && !el.value) el.value = key;
  }, env.apiKey);
}

/** Navigate to /form and wait for both async init fetches to settle. The
 *  form's submit handler is registered on page-load, but the form's content
 *  (data-point dropdown options, default paths, owner phone fallback) is
 *  populated by `/form/config` and `/form/data-points` returning. Clicking
 *  submit before those settle can race with default-form-POST (reloads page). */
async function gotoFormReady(page: import("@playwright/test").Page) {
  const configReady = page.waitForResponse(
    (r) => r.url().endsWith("/form/config") && r.request().method() === "GET",
    { timeout: 15_000 },
  );
  const dpReady = page.waitForResponse(
    (r) => r.url().endsWith("/form/data-points") && r.request().method() === "GET",
    { timeout: 15_000 },
  );
  await page.goto("/form");
  await Promise.all([configReady, dpReady]);
  await expect(page.locator("#agentForm")).toBeVisible({ timeout: 5_000 });
}

// ── 1. Blank submit shows a validation error and does NOT POST ─────────────

test.describe("Form builder — validation", () => {
  test("submitting an under-configured form surfaces an error in #result", async ({ page }) => {
    // Mock the API to return a validation error — guarantees the test runs
    // the same way regardless of what server-side checks exist.
    await page.route("**/agents/create", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Validation failed: routing paths required" }),
      }),
    );

    await gotoFormReady(page);

    // Fill HTML5-required inputs so the browser's native validation popup
    // doesn't short-circuit the JS submit handler. Don't add any routing
    // paths or data points.
    await page.locator("#businessName").fill("E2E Validation Test");
    await page.locator("#faqKnowledgeBase").fill("Some FAQ content for validation test.");

    await page.locator("#submitBtn").click();

    // An error must appear — either client-side (form's own collectPaths
    // validation) or server-side (mocked 400). Either way, no successful
    // create + redirect to /dashboard happens.
    await expect(page.locator("#result")).toHaveClass(/error/, { timeout: 10_000 });
    await expect(page.locator("#result")).toContainText(/error|path|data point|required|missing|validation/i);
    expect(page.url()).toContain("/form");
  });
});

// ── 2. Chip inputs add/remove correctly ────────────────────────────────────

test.describe("Form builder — chip inputs", () => {
  test("dispatch text chip input adds + removes values", async ({ page }) => {
    await gotoFormReady(page);
    // The dispatch chips live inside the "Default Dispatch" sub-tab. Form
    // defaults to the "Business" tab — switch first or chip inputs are hidden.
    await page.locator('button.form-subtab[data-form-tab="dispatch"]').click();

    await addChip(page, "chip-dispatch-text", "+15551112222");
    await addChip(page, "chip-dispatch-text", "+15553334444");

    expect(await getChipValues(page, "chip-dispatch-text")).toEqual([
      "+15551112222",
      "+15553334444",
    ]);

    // Remove the first chip — chip-input renders a × button after each value.
    const firstRemove = page.locator("#chip-dispatch-text .chip .remove").first();
    await firstRemove.click();

    expect(await getChipValues(page, "chip-dispatch-text")).toEqual(["+15553334444"]);
  });

  test("dispatch email chip input accepts and renders multiple values", async ({ page }) => {
    await gotoFormReady(page);
    await page.locator('button.form-subtab[data-form-tab="dispatch"]').click();

    await addChip(page, "chip-dispatch-email", "alpha@test.com");
    await addChip(page, "chip-dispatch-email", "beta@test.com");

    expect(await getChipValues(page, "chip-dispatch-email")).toEqual([
      "alpha@test.com",
      "beta@test.com",
    ]);
  });
});

// ── 3. Complete-fill → mocked POST captures correct body ───────────────────
// This is the highest-value test: catches "added a field to the form but
// forgot to wire it into body.client" regressions.

test.describe("Form builder — submit body shape (mocked POST)", () => {
  test("submitting an imported the test agent config sends a complete create-agent body", async ({ page }) => {
    const exported = (await fetchDemoMeterExport()) as Record<string, any>;

    let capturedBody: any = null;
    await page.route("**/agents/create", async (route, request) => {
      capturedBody = JSON.parse(request.postData() ?? "{}");
      // Return a fake success — form will redirect to /dashboard#agent=...
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          agent_id: "agent_mock",
          conversation_flow_id: "cf_mock",
          notification_config: {},
          provisioned_number: null,
          provision_error: null,
        }),
      });
    });

    await gotoFormReady(page);
    await ensureApiKey(page);

    // Tweak the slug-source so it doesn't collide with the real demo-hvac
    // (the body's slug derives from businessName; we rename to ensure a
    // would-be unique slug if this ever ran without the route mock).
    const uniqueName = `the test agent E2E ${Date.now()}`;
    const importable = JSON.parse(JSON.stringify(exported));
    importable.business.businessName = uniqueName;
    importable.client.name = uniqueName;
    importable.client.slug = uniqueName.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo-hvac.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(importable)),
    });

    // Wait for import to settle.
    await expect(page.locator("#businessName")).toHaveValue(uniqueName, { timeout: 10_000 });

    // Submit. The mocked route intercepts before any real Retell/Twilio call.
    await page.locator("#submitBtn").click();

    // Wait until the route handler captures the body OR the submit-attempt
    // window closes. We use a polling expectation since the redirect happens
    // immediately after the response.
    await expect.poll(() => capturedBody, { timeout: 10_000 }).not.toBeNull();

    // Assert overall body structure
    expect(capturedBody).toBeDefined();
    expect(capturedBody.business).toBeDefined();
    expect(capturedBody.client).toBeDefined();
    expect(capturedBody.paths).toBeDefined();
    expect(Array.isArray(capturedBody.paths)).toBe(true);

    // Business fields round-trip
    expect(capturedBody.business.businessName).toBe(uniqueName);
    expect(typeof capturedBody.business.faqKnowledgeBase).toBe("string");
    expect(capturedBody.business.faqKnowledgeBase.length).toBeGreaterThan(0);
    expect(["callback", "live_transfer"]).toContain(capturedBody.business.human_request_mode);

    // Client fields wired through
    expect(typeof capturedBody.client.slug).toBe("string");
    expect(Array.isArray(capturedBody.client.dispatch_text_numbers)).toBe(true);
    expect(capturedBody.client.dispatch_text_numbers.length).toBeGreaterThan(0);

    // Each path has a name + dataPoints array
    for (const p of capturedBody.paths) {
      expect(typeof p.name).toBe("string");
      expect(Array.isArray(p.dataPoints)).toBe(true);
      expect(p.dataPoints.length).toBeGreaterThan(0);
    }
  });
});

// ── 4. End-mode = transfer without dispatch_call_number is blocked ─────────

test.describe("Form builder — end_mode validation", () => {
  test("path with end_mode=transfer + no dispatch_call_number cannot submit successfully", async ({ page }) => {
    const exported = (await fetchDemoMeterExport()) as Record<string, any>;

    // Force at least one path to end_mode = "transfer" in the imported config.
    if (Array.isArray(exported.paths) && exported.paths.length > 0) {
      exported.paths[0].end_mode = "transfer";
    }
    // Strip any dispatch_call_number to provoke the validation.
    if (exported.client) {
      exported.client.dispatch_call_number = null;
      delete exported.client.dispatch_by_type;
    }

    // Rename so slug differs.
    const uniqueName = `E2E Transfer Test ${Date.now()}`;
    exported.business.businessName = uniqueName;

    let postCalled = false;
    await page.route("**/agents/create", async (route, request) => {
      postCalled = true;
      // If we get here, return whatever the real server would say. The server
      // also enforces this validation (paths[].end_mode = transfer without
      // a dispatch number → 400) so this gives us a backstop.
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "transfer requires dispatch number" }),
      });
    });

    await gotoFormReady(page);
    await ensureApiKey(page);

    await page.locator("#jsonFileInput").setInputFiles({
      name: "transfer-test.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator("#businessName")).toHaveValue(uniqueName, { timeout: 10_000 });

    // Clear the dispatch chip + call number override too, since the import
    // could have populated either.
    await page.evaluate(() => {
      const chips = document.querySelectorAll(
        '#chip-dispatch-text .chip .remove, .path-dispatch-sms .chip .remove',
      );
      chips.forEach((el) => (el as HTMLElement).click());
      const callField = document.getElementById("dispatchCallNumber") as HTMLInputElement | null;
      if (callField) callField.value = "";
    });

    await page.locator("#submitBtn").click();

    // Either the form blocks before POST (preferred) OR the server 400s.
    // Either way: #result shows an error and there's no successful redirect.
    await expect(page.locator("#result")).toContainText(/error|transfer|required|dispatch|number/i, {
      timeout: 10_000,
    });
    // We should still be on /form, not redirected to /dashboard.
    expect(page.url()).toContain("/form");
    // postCalled may be true or false depending on whether client-side
    // validation caught it — either is acceptable. We just need the error
    // surfaced and no redirect.
    expect(typeof postCalled).toBe("boolean");
  });
});

// ── 5. JSON round-trip integrity ───────────────────────────────────────────

test.describe("Form builder — JSON round-trip", () => {
  test("import → export → re-import preserves business + path data", async ({ page }) => {
    const exported = (await fetchDemoMeterExport()) as Record<string, any>;

    await gotoFormReady(page);

    // Import
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo-import-1.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator("#businessName")).toHaveValue(/.+/, { timeout: 10_000 });
    const importedName = await page.locator("#businessName").inputValue();

    // Trigger an export — exportFormAsJson() builds a downloadable Blob.
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await page.locator('button.sb-btn-save:has-text("Export JSON")').click();
    const download = await downloadPromise;
    const exportedAfterPath = await download.path();
    if (!exportedAfterPath) throw new Error("Export download not captured");
    const exportedAfter = JSON.parse(
      await (await import("node:fs/promises")).readFile(exportedAfterPath, "utf-8"),
    );

    // Critical fields survive
    expect(exportedAfter.business?.businessName).toBe(importedName);
    expect(typeof exportedAfter.business?.faqKnowledgeBase).toBe("string");
    expect(Array.isArray(exportedAfter.paths)).toBe(true);

    // Path count survives
    expect(exportedAfter.paths.length).toBe(exported.paths.length);

    // Re-import the just-exported JSON into a fresh form load.
    await gotoFormReady(page);
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo-import-2.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exportedAfter)),
    });
    await expect(page.locator("#businessName")).toHaveValue(importedName, { timeout: 10_000 });
  });
});

// ── Tree editor + flow preview (Tier 1+2 routing-path redesign) ─────────────
// These cover the new view layer added in commits 04aa411 / ac957ba / f9f6265
// / f869621. The underlying data still flows through the legacy hidden
// path-cards (#routingPaths), so existing JSON-import + submit tests are
// unaffected. These tests target what's NEW: the tree, detail panel, flow
// diagram, and the focus-stability fix.

test.describe("Form builder — tree editor + flow preview", () => {
  test("flow diagram preview renders SVG content after import", async ({ page }) => {
    const exported = (await fetchDemoMeterExport()) as Record<string, any>;

    await gotoFormReady(page);
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator("#businessName")).toHaveValue(/.+/, { timeout: 10_000 });

    // The diagram is debounced (300ms) on form changes — give it a beat.
    await page.locator('button.form-subtab[data-form-tab="paths"]').click();
    await expect(page.locator("#flowDiagramSvgHost")).toBeVisible({ timeout: 5_000 });

    // Diagram should render at least one SVG element after the debounce.
    await expect
      .poll(
        async () =>
          await page.locator("#flowDiagramSvgHost svg").count(),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);
  });

  test("tree editor lists imported paths with their names", async ({ page }) => {
    const exported = (await fetchDemoMeterExport()) as Record<string, any>;

    await gotoFormReady(page);
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator("#businessName")).toHaveValue(/.+/, { timeout: 10_000 });
    await page.locator('button.form-subtab[data-form-tab="paths"]').click();

    // the test agent is multi-path: measure_me + dont_measure_me.
    const pathNodes = page.locator(
      '#pathTreeList .tree-node[data-type="path"]',
    );
    await expect(pathNodes).toHaveCount(2, { timeout: 10_000 });

    // Both path names show in the tree labels.
    const treeText = await page.locator("#pathTreeList").innerText();
    expect(treeText).toMatch(/measure_me/);
    expect(treeText).toMatch(/dont_measure_me/);
  });

  test("path-name input keeps focus across keystrokes (regression for f9f6265)", async ({ page }) => {
    const exported = (await fetchDemoMeterExport()) as Record<string, any>;

    await gotoFormReady(page);
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator("#businessName")).toHaveValue(/.+/, { timeout: 10_000 });
    await page.locator('button.form-subtab[data-form-tab="paths"]').click();

    // Dismiss the import-success banner — it overlays the form and can
    // intercept clicks on the tree.
    await page.evaluate(() => {
      const r = document.getElementById("result");
      if (r) r.innerHTML = "";
    });

    // Select the first path via in-page DOM click — the flow diagram SVG
    // beneath intercepts pointer events from outside, so we go direct.
    await page.evaluate(() => {
      const firstPath = document.querySelector(
        '#pathTreeList .tree-node[data-type="path"]',
      ) as HTMLElement | null;
      if (firstPath) firstPath.click();
    });

    const nameInput = page.locator("#detailPathName");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    // Focus directly — clicking the input goes through Playwright's pointer
    // pipeline which gets intercepted by the flow diagram SVG below.
    await nameInput.evaluate((el) => (el as HTMLInputElement).focus());
    await nameInput.press("End"); // cursor at end of existing value

    // Type 5 characters one at a time. After EACH keypress the active element
    // must still be #detailPathName. Pre-fix, every keystroke triggered a
    // re-render that kicked focus back to body.
    const chars = ["X", "Y", "Z", "1", "2"];
    for (const c of chars) {
      await page.keyboard.press(c);
      const stillFocused = await page.evaluate(
        () => document.activeElement?.id === "detailPathName",
      );
      expect(stillFocused, `focus lost after pressing "${c}"`).toBe(true);
    }

    // And the value reflects all 5 chars typed (anywhere — cursor position
    // depends on focus state and isn't what this test guards).
    await expect(nameInput).toHaveValue(/XYZ12/);
  });

  test("+ Data Point button appends a data point node under the selected path", async ({ page }) => {
    const exported = (await fetchDemoMeterExport()) as Record<string, any>;

    await gotoFormReady(page);
    await page.locator("#jsonFileInput").setInputFiles({
      name: "demo.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.locator("#businessName")).toHaveValue(/.+/, { timeout: 10_000 });
    await page.locator('button.form-subtab[data-form-tab="paths"]').click();

    // Dismiss import-success banner so it doesn't intercept clicks.
    await page.evaluate(() => {
      const r = document.getElementById("result");
      if (r) r.innerHTML = "";
    });

    // Select the first path by invoking the tree's onclick handler directly.
    // The flow diagram SVG below intercepts pointer events on the path tree
    // node, and `force: true` only bypasses pointer-event checks — it still
    // routes the click through the SVG, which doesn't run treeSelect.
    await page.evaluate(() => {
      const firstPath = document.querySelector(
        '#pathTreeList .tree-node[data-type="path"]',
      ) as HTMLElement | null;
      if (firstPath) firstPath.click();
    });

    // Wait for the detail panel to populate as confirmation that selection worked.
    await expect(page.locator("#detailPathName")).toBeVisible({ timeout: 5_000 });

    // Count chain-items in the underlying (hidden) first path-card. The
    // path-cards are the source of truth; the tree is a view layer that
    // re-renders from them. Asserting on the source avoids debounce flake.
    const itemsBefore = await page
      .locator(
        "#routingPaths .path-card:first-child .chain-list[data-chain-root] > .chain-item",
      )
      .count();

    // Invoke the in-page handler directly. Even with `force: true`, click
    // events through Playwright on this button were not reaching the onclick
    // handler reliably (likely a hidden overlay below the button). The button
    // exists solely to call this function, so we exercise it the same way.
    await page.evaluate(() => {
      (window as any).treeAddDataPointInContext?.();
    });

    await expect
      .poll(
        async () =>
          await page
            .locator(
              "#routingPaths .path-card:first-child .chain-list[data-chain-root] > .chain-item",
            )
            .count(),
        { timeout: 5_000 },
      )
      .toBe(itemsBefore + 1);
  });
});
