import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-admin-browser-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client'; import { NativeAdministration } from '${root}/src/components/hermes/native-administration'; createRoot(document.getElementById('root')!).render(<NativeAdministration connectionId="fixture" sessionId="session" allowed={true} running={false}/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') } });
const received = [];
let probeCount = 0;
const inventory = { profileName: 'default', session: { reasoning: { supported: true, value: 'medium' }, fast: { supported: true, value: 'normal' } }, profile: { reasoning: { supported: true, value: 'low' }, fast: { supported: true, value: 'normal' } }, mcp: { servers: [{ name: 'fixture-server', transport: 'stdio', enabled: true, source: 'config', status: 'connected', tools: 2, envKeys: ['FIXTURE_KEY'], hasOAuth: false }], catalog: [{ name: 'fixture-preset', installed: false, requires: ['FIXTURE_KEY'] }] } };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') { res.end(JSON.stringify(inventory)); return; }
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const input = JSON.parse(Buffer.concat(bytes).toString()).input; received.push(input);
  if (input.operation === 'setting') inventory[input.scope][input.key].value = input.value;
  if (input.operation === 'install') inventory.mcp.catalog[0].installed = true;
  if (input.operation === 'test') {
    ++probeCount;
    res.end(JSON.stringify(probeCount === 1
      ? { ok: true, tools: ['fixture-tool'], prompts: 1, resources: 0, oauthNeeded: false, oauthTokensPresent: null }
      : { ok: false, tools: [], prompts: 0, resources: 0, oauthNeeded: true, oauthTokensPresent: probeCount === 2 ? true : probeCount === 3 ? false : null }));
    return;
  }
  res.end(JSON.stringify({ accepted: true }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Native settings & MCP' }).click();
  await expect(page.getByText('Hermes profile: default')).toBeVisible();
  await page.getByLabel('Setting value', { exact: true }).click(); await page.getByRole('option', { name: 'high', exact: true }).click();
  await page.getByRole('button', { name: 'Apply setting' }).click();
  await expect(page.getByText('Current: high.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('fixture-server: Connection succeeded')).toBeVisible();
  await page.getByLabel('Install a Hermes preset', { exact: true }).click(); await page.getByRole('option', { name: 'fixture-preset', exact: true }).click();
  await page.getByRole('button', { name: 'Install preset' }).click();
  await page.getByLabel('Update a protected credential', { exact: true }).click(); await page.getByRole('option', { name: 'fixture-server', exact: true }).click();
  await page.getByLabel('MCP credential key', { exact: true }).click(); await page.getByRole('option', { name: 'FIXTURE_KEY', exact: true }).click();
  await page.getByLabel('Protected MCP credential').fill('synthetic-protected-value');
  await page.getByRole('button', { name: 'Save protected credential' }).click();
  await expect(page.getByLabel('Protected MCP credential')).toHaveValue('');
  expect(await page.locator('body').textContent()).not.toContain('synthetic-protected-value');
  expect(received.map(input => input.operation)).toEqual(['setting', 'test', 'install', 'credential']);
  expect(received[0]).toMatchObject({ scope: 'session', key: 'reasoning', value: 'high' });
  expect(received[3]).toMatchObject({ name: 'fixture-server', envVar: 'FIXTURE_KEY', value: 'synthetic-protected-value' });
  await page.getByLabel('Setting key', { exact: true }).click(); await page.getByRole('option', { name: 'Speed tier', exact: true }).click();
  page.on('dialog', dialog => dialog.accept());
  for (const [scope, label] of [['session', 'This chat'], ['profile', 'Profile defaults']]) {
    await page.getByLabel('Setting scope', { exact: true }).click(); await page.getByRole('option', { name: label, exact: true }).click();
    for (const tier of ['auto', 'cold']) {
      await page.getByLabel('Setting value', { exact: true }).click(); await page.getByRole('option', { name: tier, exact: true }).click();
      await page.getByRole('button', { name: 'Apply setting' }).click();
      await expect(page.getByText(`Current: ${tier}.`, { exact: false })).toBeVisible();
      expect(received.at(-1)).toMatchObject({ operation: 'setting', scope, key: 'fast', value: tier });
    }
  }
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('fixture-server: Connection failed; check the server in Hermes')).toBeVisible();
  await expect(page.getByText('fixture-server: OAuth sign-in required in Hermes')).toHaveCount(0);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('fixture-server: OAuth sign-in required in Hermes')).toBeVisible();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('fixture-server: Connection failed; check the server in Hermes')).toBeVisible();
  await expect(page.getByText('fixture-server: OAuth sign-in required in Hermes')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('PASS: native settings including auto/cold in both scopes, safe MCP inventory, token-aware probes, preset install, protected credential clearing; no browser errors.');
} finally { await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
