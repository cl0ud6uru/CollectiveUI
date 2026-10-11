import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./e2e',testMatch:'group-activity.spec.ts',workers:1,timeout:30_000,
  outputDir:process.env.GROUP_ACTIVITY_RESULTS??'/tmp/collective-group-activity-results',
  use:{baseURL:'http://127.0.0.1:3139',viewport:{width:1360,height:900},screenshot:'only-on-failure',trace:'retain-on-failure',
    launchOptions:process.env.PLAYWRIGHT_CHROMIUM_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH}:{}},
  webServer:{command:'node tests/browser/group-activity-server.mjs',cwd:'..',url:'http://127.0.0.1:3139',reuseExistingServer:false},
});
