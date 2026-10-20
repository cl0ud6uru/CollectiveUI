import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'mcp-apps.spec.ts', workers: 1, timeout: 45000,
  outputDir: '/tmp/collectiveui-mcp-apps-browser-results',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3197', viewport: { width: 1180, height: 960 }, trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {} },
  webServer: { cwd: path.resolve(__dirname, '..'), command: 'node tests/fixtures/mcp-apps/server.mjs', url: 'http://127.0.0.1:3197', reuseExistingServer: false, timeout: 30000 },
});
