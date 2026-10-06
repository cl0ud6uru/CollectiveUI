import { defineConfig, devices } from "@playwright/test";

/** Dedicated disposable LDAP installation; avoids the ordinary E2E seed/global setup. */
export default defineConfig({
  testDir: "../e2e", testMatch: "ldap-passkeys.spec.ts", workers: 1, timeout: 180_000, expect: { timeout: 30_000 },
  use: { ...devices["Desktop Chrome"], baseURL: process.env.BASE_URL ?? "http://localhost:3109", trace: "retain-on-failure" },
});
