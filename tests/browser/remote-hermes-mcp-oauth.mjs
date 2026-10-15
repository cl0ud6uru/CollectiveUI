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
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-mcp-oauth-browser-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react'; import {createRoot} from '${root}/node_modules/react-dom/client'; import {NativeMcpOAuth} from '${root}/src/components/hermes/native-mcp-oauth'; const root = createRoot(document.getElementById('root')); window.fixtureRender = (options = {}) => { const connectionId = options.connectionId || 'fixture'; const sessionId = options.sessionId || 'session'; root.render(options.unmount ? <p>Closed</p> : <NativeMcpOAuth key={connectionId + ':' + sessionId} connectionId={connectionId} sessionId={sessionId} profile="default" name="fixture-oauth" disabled={Boolean(options.disabled)}/>); }; window.fixtureRender();`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') } });
const requests = [];
let pollStatus = 'pending', holdStart = false, delayed, cancelStatus = 'cancelled';
const pending = () => ({ status: 'pending', flow: 'synthetic-protected-flow', authorizationUrl: 'https://auth.example.invalid/authorize?state=synthetic-state', expiresAt: Date.now() + 60_000 });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push({ path: url.pathname, ...body });
  res.setHeader('Content-Type', 'application/json');
  if (body.input.operation === 'start') {
    if (holdStart) { delayed = () => res.end(JSON.stringify(pending())); return; }
    res.end(JSON.stringify(pending())); return;
  }
  if (body.input.operation === 'poll') { res.end(JSON.stringify({ status: pollStatus, message: pollStatus === 'approved' ? 'Hermes confirmed the saved authorization.' : 'Waiting for authorization in Hermes.' })); return; }
  res.end(JSON.stringify({ status: cancelStatus, message: cancelStatus === 'uncertain' ? 'Hermes already approved authorization. Cancellation does not revoke the grant.' : 'Pending authorization cancelled; this does not revoke an existing grant.' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage(), errors = [], confirmations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { confirmations.push(dialog.message()); dialog.accept(); });
  const open = async () => { await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.getByRole('button', { name: 'Authorize MCP OAuth' })).toBeVisible(); };
  await open();
  expect(requests).toHaveLength(0);
  pollStatus = 'approved';
  await page.getByRole('button', { name: 'Authorize MCP OAuth' }).click();
  await expect(page.getByRole('link', { name: 'Open provider sign-in' })).toHaveAttribute('target', '_blank');
  expect(confirmations[0]).toContain('profile “default”');
  expect(confirmations[0]).toContain('cannot revoke');
  expect(requests[0].input).toMatchObject({ operation: 'start', name: 'fixture-oauth', confirmed: true });
  expect(requests[0].input.profile).toBeUndefined();
  await expect(page.getByRole('status')).toContainText('confirmed the saved authorization');
  expect(requests.filter(item => item.input.operation === 'start')).toHaveLength(1);
  expect(requests.filter(item => item.input.operation === 'cancel')).toHaveLength(0);
  await expect(page.getByRole('link', { name: 'Open provider sign-in' })).toHaveCount(0);

  // Panel closure cleans up the original flow without another start or a callback relay.
  pollStatus = 'pending'; requests.length = 0;
  await page.getByRole('button', { name: 'Authorize MCP OAuth' }).click();
  await expect(page.getByRole('link')).toBeVisible();
  await page.evaluate(() => window.fixtureRender({ unmount: true }));
  await expect.poll(() => requests.filter(item => item.input.operation === 'cancel').length).toBe(1);
  expect(requests.at(-1)).toMatchObject({ path: '/api/hermes/fixture/mcp-oauth', sessionId: 'session', input: { flow: 'synthetic-protected-flow' } });

  // A start accepted while its panel is closing is cancelled after its response arrives.
  requests.length = 0; holdStart = true; delayed = undefined;
  await open();
  await page.getByRole('button', { name: 'Authorize MCP OAuth' }).click();
  await expect.poll(() => Boolean(delayed)).toBe(true);
  await page.evaluate(() => window.fixtureRender({ unmount: true })); delayed();
  await expect.poll(() => requests.filter(item => item.input.operation === 'cancel').length).toBe(1);
  await expect(page.getByRole('link')).toHaveCount(0);

  // Native activity beginning during start also prevents opening an authorization link.
  requests.length = 0; delayed = undefined;
  await open();
  await page.getByRole('button', { name: 'Authorize MCP OAuth' }).click();
  await expect.poll(() => Boolean(delayed)).toBe(true);
  await page.evaluate(() => window.fixtureRender({ disabled: true })); delayed();
  await expect.poll(() => requests.filter(item => item.input.operation === 'cancel').length).toBe(1);
  await expect(page.getByRole('link')).toHaveCount(0);

  requests.length = 0; holdStart = false;
  await open();
  await page.getByRole('button', { name: 'Authorize MCP OAuth' }).click();
  await expect(page.getByRole('link')).toBeVisible();
  await page.evaluate(() => window.fixtureRender({ connectionId: 'other', sessionId: 'other-chat' }));
  await expect.poll(() => requests.filter(item => item.input.operation === 'cancel').length).toBe(1);
  expect(requests.at(-1)).toMatchObject({ path: '/api/hermes/fixture/mcp-oauth', sessionId: 'session' });

  requests.length = 0; cancelStatus = 'uncertain';
  await open();
  await page.getByRole('button', { name: 'Authorize MCP OAuth' }).click();
  await expect(page.getByRole('link')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel authorization' }).click();
  await expect(page.getByRole('status')).toContainText('does not revoke');
  expect(requests.map(item => item.input.operation)).toEqual(['start', 'cancel']);
  expect(errors).toEqual([]);
  console.log('PASS: explicit OAuth consent/link, approved polling, closure and scope cleanup, delayed-start cancellation, busy-start interruption, no start replay, and honest already-approved cancellation; synthetic accounts, no provider navigation.');
} finally { await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
