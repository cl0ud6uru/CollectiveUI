import { defineConfig } from "@playwright/test";
import config from "./playwright.config";

// No broad E2E seed/cleanup: this suite owns only its unique disposable fixtures.
export default defineConfig({
  ...config,
  globalSetup: undefined,
  testMatch: "admin-bots-delete.spec.ts",
  use: { ...config.use, ignoreHTTPSErrors: true }, // Local fixture TLS certificate.
});
