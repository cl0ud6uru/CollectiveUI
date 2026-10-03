import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  outputDir: "/tmp/collective-hermes-browser-results", testDir: "tests/e2e", testMatch: "hermes-provisioning.spec.ts", workers: 1, timeout: 120000,
  use: { ...devices["Desktop Chrome"], baseURL: process.env.BASE_URL ?? "http://localhost:3307", viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
