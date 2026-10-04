import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "native-search.spec.ts", timeout: 120_000, workers: 1,
  outputDir: "/tmp/collective-native-search-browser-results",
  use: { ...devices["Desktop Chrome"], baseURL: process.env.BASE_URL ?? "http://localhost:3126", actionTimeout: 15_000,
    viewport: { width: 1360, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {} },
});
