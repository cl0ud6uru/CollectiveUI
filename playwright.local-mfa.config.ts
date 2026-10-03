import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e", testMatch: "local-factors.spec.ts", workers: 1, timeout: 90000,
  expect: { timeout: 15000 },
  outputDir: "/tmp/collective-mfa-browser-results",
  use: { ...devices["Desktop Chrome"], baseURL: process.env.BASE_URL ?? "http://localhost:3100", viewport: { width: 1280, height: 900 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium" }, screenshot: "only-on-failure", trace: "off" },
});
