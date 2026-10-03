import { defineConfig, devices } from "@playwright/test";

/** Explicit opt-in; needs a migrated collective_service_bot_browser_test DB and a local app with the same env. */
export default defineConfig({
  testDir: "./e2e", testMatch: "service-bots.spec.ts", timeout: 90_000, workers: 1,
  outputDir: "/tmp/collective-service-bot-browser-results",
  use: { ...devices["Desktop Chrome"], baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3055",
    viewport: { width: 1360, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {} },
});
