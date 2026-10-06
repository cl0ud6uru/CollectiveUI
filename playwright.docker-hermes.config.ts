import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  outputDir:'/tmp/docker-hermes-browser-results',testDir:'tests/e2e',testMatch:process.env.DOCKER_HERMES_NETWORK_BROWSER === '1' ? 'docker-hermes-network.spec.ts' : 'docker-hermes.spec.ts',workers:1,timeout:120000,
  use:{...devices['Desktop Chrome'],baseURL:process.env.BASE_URL ?? 'http://localhost:3327',viewport:{width:1360,height:900},
    ignoreHTTPSErrors:process.env.DOCKER_HERMES_BROWSER_HTTPS === '1',
    launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH},screenshot:'only-on-failure',trace:'retain-on-failure'},
});
