import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Real connected-account components with synthetic HTTP responses only.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'codex-device-browser-'));
const keyPath = path.join(dir, 'key.pem'), certPath = path.join(dir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `
import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client';
import { ChatGPTConnection } from '${root}/src/components/settings/chatgpt-connection';
import { CodexApproval } from '${root}/src/components/chat/codex-approval';
createRoot(document.getElementById('root')).render(<main className="mx-auto max-w-2xl space-y-5 p-4"><ChatGPTConnection /><section aria-label="Approval fixtures"><CodexApproval data={{id:'approval-deny',label:'Codex wants to run a command',state:'pending'}} /><CodexApproval data={{id:'approval-stop',label:'Codex wants to edit a file',state:'pending'}} /></section></main>);
`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') } });
const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
const deviceUrl = 'https://auth.openai.com/codex/device';
const setup = { eligible: true, reason: null, canPrepareRuntime: true, runtime: { state: 'ready', selfEnrollment: true, enrolled: false, runtimeState: 'not_started' } };
const account = () => ({ allowed: true, reason: null, credential: null, backends: { native: { state: 'not_connected' }, codex: { state: 'not_started' } }, onboarding: { state: 'blocked', reason: 'Native configuration pending.' }, setup: { ...setup, eligible: false, reason: 'Native sign-in requires a local app.', authentication: { state: 'companion_required', reason: 'Native sign-in requires a local app.' } }, deviceSetup: structuredClone(setup), signIn: null });
let accountView = account(), codexView = { state: 'not_started' }, actions = [], approvalActions = [], failRead = false, failConnect = false, failConfirm = false;
const verified = { state: 'confirm', email: 'personal@example.test', workspaceId: 'verified-account-42', planType: 'plus' };
const pending = () => ({ state: 'pending', login: { verificationUrl: deviceUrl, userCode: 'ABCD-EFGH', expiresAt: new Date(Date.now() + 900000).toISOString() } });
const json = (res, data, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(data)); };
const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'application/javascript'); return res.end(bundle.outputFiles[0].contents); }
  if (url.pathname === '/style.css') { res.setHeader('content-type', 'text/css'); return res.end(css.css); }
  if (url.pathname === '/api/me/chatgpt' && req.method === 'GET') return json(res, accountView);
  if (url.pathname === '/api/me/codex' && req.method === 'GET') {
    if (failRead) { failRead = false; return json(res, { error: 'Synthetic stock Codex status outage.' }, 503); }
    return json(res, codexView);
  }
  if (url.pathname === '/api/me/codex' && req.method === 'POST') {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); actions.push(body);
    if (body.action === 'connect') {
      if (failConnect) { failConnect = false; return json(res, { error: 'Synthetic runtime preparation failed. Retry after checking status.' }, 503); }
      codexView = pending();
    } else if (body.action === 'confirm') {
      if (failConfirm) { failConfirm = false; codexView = { ...verified, email: 'changed@example.test', workspaceId: 'changed-account-43' }; return json(res, { error: 'The verified account changed. Review the current account before confirming.' }, 409); }
      expect(body.expected).toEqual({ email: codexView.email, workspaceId: codexView.workspaceId });
      codexView = { ...codexView, state: 'connected' };
    } else if (body.action === 'disconnect' || body.action === 'cancel') codexView = { state: 'signed_out' };
    else if (body.action === 'start') codexView = { ...codexView, state: 'connected' };
    return json(res, codexView);
  }
  const approval = url.pathname.match(/^\/api\/me\/codex\/approvals\/([^/]+)$/);
  if (approval && req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; approvalActions.push({ id: approval[1], decision: req.headers['x-codex-decision'], body }); return json(res, { ok: true }); }
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>'); }
  json(res, { error: 'Unexpected synthetic route.' }, 404);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `https://localhost:${server.address().port}`;
let browser;
const errors = [];
const consentLabel = 'I authorize this installation to prepare my private Codex workspace and use my ChatGPT account for stock Codex.';
const confirmLabel = 'I confirm this verified OpenAI account belongs to me and authorize connecting it to my signed-in CollectiveUI account.';
const reset = () => { accountView = account(); codexView = { state: 'not_started' }; actions = []; failRead = false; failConnect = false; failConfirm = false; };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, ignoreHTTPSErrors: true });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.fixtureLaunches = []; window.open = (url, target, features) => { window.fixtureLaunches.push({ url, target, features }); return null; }; });
  const open = async () => { await page.goto(origin); await expect(page.getByRole('heading', { name: 'Stock Codex', exact: true })).toBeVisible(); };
  const start = async (button = 'Connect stock Codex') => { await page.getByLabel(consentLabel).check(); await page.getByRole('button', { name: button, exact: true }).click(); await expect(page.getByLabel('OpenAI device code')).toHaveText('ABCD-EFGH'); };
  reset(); await open();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Connect stock Codex', exact: true })).toBeDisabled();
  await start();
  expect(actions).toEqual([{ action: 'connect', accepted: true, consentVersion: 1 }]);
  expect(await page.evaluate(() => window.fixtureLaunches)).toEqual([{ url: deviceUrl, target: '_blank', features: 'noopener,noreferrer' }]);
  await expect(page.getByRole('link', { name: 'Open OpenAI device sign-in' })).toHaveAttribute('href', deviceUrl);
  if (process.env.CODEX_DEVICE_SCREENSHOTS === '1') {
    await mkdir(path.join(root, 'docs/images'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs/images/codex-device-pending-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.screenshot({ path: path.join(root, 'docs/images/codex-device-pending-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 1000 });
  }
  // No browser-provided token or local helper is involved; account email differs from local identity.
  codexView = structuredClone(verified);
  await expect(page.getByText('personal@example.test', { exact: true })).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole('button', { name: 'Confirm stock Codex account' })).toBeDisabled();
  if (process.env.CODEX_DEVICE_SCREENSHOTS === '1') await page.screenshot({ path: path.join(root, 'docs/images/codex-device-confirm-mobile.png'), fullPage: true });
  expect(actions).toHaveLength(1);
  await page.getByLabel(confirmLabel).check(); await page.getByRole('button', { name: 'Confirm stock Codex account' }).click();
  await expect(page.getByText('Your ChatGPT account is connected to stock Codex.', { exact: true })).toBeVisible();
  expect(actions[1]).toEqual({ action: 'confirm', accepted: true, consentVersion: 1, expected: { email: verified.email, workspaceId: verified.workspaceId } });
  expect(JSON.stringify(actions)).not.toMatch(/accessToken|refreshToken|loginId|userId|ownerId/);
  for (const width of [320, 390, 768, 1280]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`).toBe(true); }
  await start('Reconnect stock Codex');
  expect(actions.slice(-2)).toEqual([{ action: 'disconnect' }, { action: 'connect', accepted: true, consentVersion: 1 }]);
  await page.getByRole('button', { name: 'Cancel Codex sign-in' }).click();
  await expect(page.getByText('Stock Codex is signed out. Connect again to continue.', { exact: true })).toBeVisible();
  expect(actions.at(-1)).toEqual({ action: 'cancel' });
  // Expiry and authorization failure allow a new code.
  reset(); codexView = { state: 'expired' }; await open();
  await expect(page.getByText('The device code expired. Connect again to get a new code.', { exact: true })).toBeVisible();
  await start('Retry stock Codex sign-in');
  reset(); codexView = { state: 'failed', reason: 'OpenAI declined this synthetic sign-in.' }; await open();
  await expect(page.getByText('OpenAI declined this synthetic sign-in.')).toBeVisible(); await start();
  // Failed confirmation cannot bind a changed server identity.
  reset(); codexView = structuredClone(verified); failConfirm = true; await open();
  await page.getByLabel(confirmLabel).check(); await page.getByRole('button', { name: 'Confirm stock Codex account' }).click();
  await expect(page.getByRole('alert')).toContainText('verified account changed');
  await page.getByRole('button', { name: 'Retry Codex status', exact: true }).click();
  await expect(page.getByText('changed@example.test', { exact: true })).toBeVisible();
  await expect(page.getByLabel(confirmLabel)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Confirm stock Codex account' })).toBeDisabled();
  // Preparation failures preserve consent, offer retry, and do not report connected.
  reset(); failConnect = true; await open(); await page.getByLabel(consentLabel).check(); await page.getByRole('button', { name: 'Connect stock Codex', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic runtime preparation failed.');
  await expect(page.getByLabel(consentLabel)).toBeChecked();
  await page.getByRole('button', { name: 'Connect stock Codex', exact: true }).click(); await expect(page.getByLabel('OpenAI device code')).toHaveText('ABCD-EFGH');
  reset(); failRead = true; await open(); await expect(page.getByRole('alert')).toContainText('Synthetic stock Codex status outage.');
  await page.getByRole('button', { name: 'Retry Codex status', exact: true }).click(); await expect(page.getByRole('button', { name: 'Connect stock Codex', exact: true })).toBeVisible();
  // Policy denial never makes connect available.
  reset(); accountView.deviceSetup = { ...setup, eligible: false, canPrepareRuntime: false, reason: 'An administrator disabled ChatGPT access.' }; codexView = { state: 'not_started', canConnect: false }; await open();
  await expect(page.getByText('An administrator disabled ChatGPT access.')).toBeVisible(); await expect(page.getByRole('button', { name: 'Connect stock Codex', exact: true })).toHaveCount(0);
  // Retained stopped workspaces and account changes expose safe recovery controls.
  reset(); codexView = { ...verified, state: 'stopped' }; await open(); await page.getByRole('button', { name: 'Start Codex workspace' }).click();
  await expect(page.getByRole('button', { name: 'Disconnect stock Codex' })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect stock Codex' }).click(); expect(actions.at(-1)).toEqual({ action: 'disconnect' });
  reset(); codexView = { ...verified, state: 'changed' }; await open();
  await expect(page.getByRole('button', { name: 'Confirm stock Codex account' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Disconnect stock Codex' })).toBeVisible();
  // Existing approval controls remain usable with the unified connection surface.
  await page.locator('section[aria-label="Approval fixtures"] > div').nth(0).getByRole('button', { name: 'Deny', exact: true }).click(); await page.locator('section[aria-label="Approval fixtures"] > div').nth(1).getByRole('button', { name: 'Stop', exact: true }).click();
  expect(approvalActions).toEqual([{ id: 'approval-deny', decision: 'decline', body: '' }, { id: 'approval-stop', decision: 'cancel', body: '' }]);
  expect(errors).toEqual([]);
  if (process.env.VERIFY_OPENAI_DEVICE_PAGE === '1') {
    const officialPage = await browser.newPage();
    await officialPage.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Official unauthenticated device boundary:', JSON.stringify({ requestedUrl: deviceUrl, actualUrl: new URL(officialPage.url()).origin + new URL(officialPage.url()).pathname, title: await officialPage.title(), visibleText: (await officialPage.locator('body').innerText()).slice(0, 1200), inputs: await officialPage.locator('input').evaluateAll(inputs => inputs.map(input => ({ name: input.name, type: input.type, placeholder: input.placeholder }))) }));
    await officialPage.close();
  }
  console.log('PASS Stock Codex browser device sign-in: consent, official page/code, polling, verified identity confirmation, changed identity refusal, cancel/expiry/failure/retry, reconnect/disconnect/start, companion-independent availability, owner-safe browser payloads, approval controls, and 320/390/768/1280 layouts. Synthetic endpoints only; no grants or production resources used.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
