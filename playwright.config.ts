import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests expect a running stack: Postgres, the app (BASE_URL), mock-llm, the worker and the dev
 * OpenLDAP directory (see README → "Running the tests").
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } }],
});
