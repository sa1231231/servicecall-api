import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pick up vitest unit + system tests, but NOT Playwright e2e specs.
    // tests/e2e/*.spec.ts is handled by `npm run test:e2e` (Playwright).
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
  },
});
