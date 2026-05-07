import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pick up vitest unit + system tests, but NOT:
    //   - Playwright e2e specs (tests/e2e/*.spec.ts → `npm run test:e2e`)
    //   - Live-API E2E (tests/live-api/**/*.test.ts → `npm run test:live-api`)
    // The live-api suite hits the deployed Railway API and provisions
    // real Twilio numbers; running it accidentally during `npm test`
    // would burn money.
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**", "tests/live-api/**"],
    coverage: {
      provider: "v8",
      // Report against ALL source files, not just files imported by tests.
      // Without this, files with zero tests are invisible in the report.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.ts",
        "src/index.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 80,
        lines: 85,
      },
    },
  },
});
