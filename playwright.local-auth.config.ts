import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  outputDir: "/tmp/collective-local-browser-results", testDir: "tests/e2e", testMatch: ["local-auth.spec.ts", "auth-providers.spec.ts"], workers: 1, timeout: 90000,
  use: { ...devices["Desktop Chrome"], baseURL: process.env.BASE_URL ?? "http://localhost:3100", viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
