import { defineConfig, devices } from "@playwright/test";
import "dotenv/config";

const baseURL = process.env.SYSTEM_TEST_URL || process.env.BASE_URL || "";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  // Skip everything if no base URL configured — matches the env-gating
  // pattern of src/__tests__/system.test.ts. Without this, tests fail
  // hard in local dev where SYSTEM_TEST_URL isn't set.
  grep: baseURL ? undefined : /__never_match__/,
  fullyParallel: false, // shadow-toggle test mutates state; serial is safer
  forbidOnly: !!process.env.CI,
  // Tests run against the deployed Railway URL — the rate-limiter and
  // cold-starts can make a single suite run brush against transient
  // network blips. One retry locally absorbs those without masking
  // real failures (a deterministically broken test will still fail both
  // attempts). CI keeps the higher count it always had.
  retries: process.env.CI ? 2 : 1,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // 15s for any single action — the staging API can be slow on cold starts
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
