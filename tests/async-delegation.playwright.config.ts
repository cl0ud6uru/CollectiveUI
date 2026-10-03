import { defineConfig, devices } from "@playwright/test";

/** Local mock model and a named disposable database; no external providers. */
export default defineConfig({
  testDir: "./e2e", testMatch: "async-delegation.spec.ts", timeout: 90_000, workers: 1,
  outputDir: "/tmp/collective-async-browser-results",
  use: { ...devices["Desktop Chrome"], baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3068",
    ignoreHTTPSErrors: process.env.TEST_HTTPS === "1",
    viewport: { width: 1360, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {} },
});
