import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Real account and approval components, backed only by synthetic HTTP fixtures.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'personal-codex-browser-'));
const keyPath = path.join(dir, 'key.pem');
const certPath = path.join(dir, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const entry = path.join(dir, 'entry.tsx');
const initialView = () => ({
  allowed: true,
  reason: null,
  credential: null,
  backends: { native: { state: 'not_connected' }, codex: { state: 'not_enrolled' } },
  onboarding: { state: 'ready', reason: null },
  setup: {
    eligible: true,
    reason: null,
    runtime: { state: 'ready', selfEnrollment: true, enrolled: false, runtimeState: 'not_started' },
    canPrepareRuntime: true,
    authentication: { state: 'companion_ready', reason: 'Open the installed ChatGPT sign-in app to continue.' },
  },
  signIn: null,
});
let connectionView = initialView();
const connectionActions = [];
const approvalActions = [];
let failAccountRead = false;
let failPrepareOnce = false;
let failSignInOnce = false;

await writeFile(entry, `
import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client';
import { ChatGPTConnection } from '${root}/src/components/settings/chatgpt-connection';
import { CodexApproval } from '${root}/src/components/chat/codex-approval';
window.fixtureFetchCalls=[];
const originalFetch=window.fetch.bind(window);
window.fetch=(input,init={})=>{
  const url=String(input);
  if(url.startsWith('/api/me/codex') || url.startsWith('/api/me/chatgpt')) window.fixtureFetchCalls.push({url,method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),body:init.body??null});
  return originalFetch(input,init);
};
const approval=location.pathname==='/approval';
createRoot(document.getElementById('root')).render(<main className="mx-auto max-w-2xl space-y-5 p-4 text-fg">
  <ChatGPTConnection />
  {approval && <section aria-label="Approval fixtures" className="space-y-3">
    <CodexApproval data={{id:'approval-deny',label:'Codex wants to run a command',state:'pending'}} />
    <CodexApproval data={{id:'approval-stop',label:'Codex wants to edit a file',state:'pending'}} />
  </section>}
</main>);
`);
const bundle = await build({
  entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') },
});
const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root })])
  .process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });

function json(res, value, status = 200) {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value));
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); return; }
  if (url.pathname === '/api/me/chatgpt' && req.method === 'GET') {
    if (failAccountRead) { failAccountRead = false; return json(res, { error: 'Synthetic account service outage.' }, 503); }
    return json(res, connectionView);
  }
  if (url.pathname === '/api/me/chatgpt' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); connectionActions.push({ action: request.action, body: request });
    if (request.action === 'prepare-runtime') {
      if (failPrepareOnce) { failPrepareOnce = false; return json(res, { error: 'Synthetic broker preparation failure. Check runtime status and retry.' }, 503); }
      connectionView.setup.runtime = { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' };
      connectionView.setup.canPrepareRuntime = true;
      connectionView.backends.codex = { state: 'not_connected' };
      return json(res, connectionView);
    }
    if (request.action === 'begin-sign-in') {
      if (failSignInOnce) { failSignInOnce = false; return json(res, { error: 'Synthetic companion launch service is unavailable. Retry local sign-in.' }, 503); }
      connectionView.signIn = { state: 'created', expiresAt: new Date(Date.now() + 120000).toISOString() };
      return json(res, { launchUrl: `collectiveui-chatgpt://connect?origin=${encodeURIComponent(`https://${req.headers.host}`)}&attempt=11111111-2222-4333-8444-555555555555&ticket=${'A'.repeat(43)}`, expiresAt: connectionView.signIn.expiresAt });
    }
    if (request.action === 'cancel-sign-in') {
      connectionView.signIn = { state: 'cancelled', expiresAt: new Date(Date.now() + 120000).toISOString() };
      return json(res, connectionView);
    }
    if (request.action === 'sync-token') {
      connectionView.backends.codex = { state: 'connected' };
      return json(res, connectionView);
    }
    if (request.action === 'disconnect') {
      connectionView.credential = null;
      connectionView.backends.native = { state: 'not_connected' };
      connectionView.backends.codex = { state: 'not_connected' };
      return json(res, connectionView);
    }
    return json(res, { error: 'Unexpected synthetic account action.' }, 400);
  }
  if (url.pathname === '/api/me/codex' && req.method === 'GET') return json(res, { state: 'unavailable' });
  const approval = url.pathname.match(/^\/api\/me\/codex\/approvals\/([^/]+)$/);
  if (approval && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    approvalActions.push({ id: decodeURIComponent(approval[1]), decision: req.headers['x-codex-decision'], body });
    return json(res, { ok: true });
  }
  if (url.pathname === '/' || url.pathname === '/approval') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>');
    return;
  }
  json(res, { error: 'fixture route not found' }, 404);
});
server.addContext('localhost', { key: await readFile(keyPath), cert: await readFile(certPath) });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `https://localhost:${server.address().port}`;
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
let browser;
const pageErrors = [];
async function reset(view = initialView()) {
  connectionView = JSON.parse(JSON.stringify(view)); connectionActions.length = 0; approvalActions.length = 0; failAccountRead = false; failPrepareOnce = false; failSignInOnce = false;
}
async function noOverflow(page, widths = [320, 390, 768, 1280]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}px`).toBe(true);
  }
}
async function openAccount(page) {
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'ChatGPT account', exact: true })).toBeVisible();
  await expect(page.getByText('Legacy Codex connection cleanup', { exact: true })).toBeVisible();
}

try {
  browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, ignoreHTTPSErrors: true });
  await page.addInitScript(() => {
    const originalOpen = window.open.bind(window);
    window.fixtureLaunches = [];
    window.open = (url, target, features) => {
      if (String(url).startsWith('collectiveui-chatgpt://')) { window.fixtureLaunches.push({ url: String(url), target }); return { opener: null }; }
      if (String(url) === 'about:blank') {
        return { opener: null, location: { set href(value) { window.fixtureLaunches.push({ url: String(value), target }); } }, close() {} };
      }
      return originalOpen(url, target, features);
    };
  });
  page.on('pageerror', error => pageErrors.push(error.message));

  await reset();
  await openAccount(page);
  await expect(page.getByText('Stock Codex:', { exact: false })).toBeVisible();
  await expect(page.getByText('Local sign-in app ready', { exact: true })).toBeVisible();
  await expect(page.getByText(/Open the installed ChatGPT sign-in app/i)).toBeVisible();
  const consent = page.getByLabel('I authorize this installation to prepare my private Codex runtime. ChatGPT plan usage is authorized separately when I sign in.');
  const prepare = page.getByRole('button', { name: 'Prepare private runtime', exact: true });
  await expect(consent).not.toBeChecked();
  await expect(prepare).toBeDisabled();
  await consent.check();
  await expect(prepare).toBeEnabled();
  await prepare.click();
  await expect(page.getByText('Prepared', { exact: true })).toBeVisible();
  await expect(page.locator('p').filter({ hasText: 'Stock Codex:' })).toContainText('not_connected');
  const prepareCalls = connectionActions.filter(call => call.action === 'prepare-runtime');
  expect(prepareCalls).toEqual([{ action: 'prepare-runtime', body: { action: 'prepare-runtime', accepted: true, consentVersion: 1 } }]);
  expect(JSON.stringify(prepareCalls)).not.toMatch(/owner|accessToken|credential|token/i);
  await noOverflow(page);

  // Sign-in needs its own explicit consent; optional runtime consent stays separate.
  const connectConsent = page.getByLabel('I authorize this installation to use my ChatGPT account for Native CollectiveUI.');
  const connectButton = page.getByRole('button', { name: 'Connect ChatGPT', exact: true });
  await expect(connectButton).toBeDisabled();
  await connectConsent.check();
  await expect(connectButton).toBeEnabled();
  await connectButton.click();
  await expect(page.getByText('Waiting for the local sign-in app to finish…')).toBeVisible();
  const signInCalls = connectionActions.filter(call => call.action === 'begin-sign-in');
  expect(signInCalls).toEqual([{ action: 'begin-sign-in', body: { action: 'begin-sign-in', accepted: true, consentVersion: 1, enableCodex: false } }]);
  expect(JSON.stringify(signInCalls)).not.toMatch(/owner|accessToken|credential|refreshToken|\bcode\b/i);
  const launches = await page.evaluate(() => window.fixtureLaunches);
  expect(launches).toHaveLength(1);
  const launchedUrl = new URL(launches[0].url);
  expect(launchedUrl.protocol).toBe('collectiveui-chatgpt:');
  expect(launchedUrl.hostname).toBe('connect');
  expect(launchedUrl.searchParams.get('origin')).toBe(new URL(origin).origin);
  expect(launchedUrl.searchParams.get('attempt')).toBe('11111111-2222-4333-8444-555555555555');
  expect(launchedUrl.searchParams.get('ticket')).toBe('A'.repeat(43));
  expect(await page.locator('body').innerText()).not.toMatch(/collectiveui-chatgpt|ticket=|11111111-2222/);
  await page.getByRole('button', { name: 'Open local sign-in app', exact: true }).click();
  expect(await page.evaluate(() => window.fixtureLaunches)).toHaveLength(2);
  expect(connectionActions.filter(call => call.action === 'begin-sign-in')).toHaveLength(1);
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  expect(connectionActions.filter(call => call.action === 'cancel-sign-in')).toEqual([{ action: 'cancel-sign-in', body: { action: 'cancel-sign-in' } }]);

  // The disabled installation remains truthful and points to the configured installer.
  const disabledView = initialView();
  disabledView.setup.authentication = { state: 'companion_required', reason: 'Local sign-in companion is not installed.', downloadUrl: 'https://downloads.example.test/companion' };
  await reset(disabledView);
  await openAccount(page);
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Get the local sign-in app' })).toHaveAttribute('href', 'https://downloads.example.test/companion');
  await noOverflow(page);

  // A completion returned by the server is sanitized and unlocks the existing controls.
  const completedView = initialView();
  completedView.credential = { email: 'alice@example.test', planType: 'plus', status: 'active', migrationRequired: false };
  completedView.backends.native = { state: 'connected' };
  completedView.backends.codex = { state: 'not_connected' };
  completedView.signIn = { state: 'complete', expiresAt: new Date(Date.now() + 120000).toISOString() };
  await reset(completedView);
  await openAccount(page);
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true })).toBeVisible();

  const staleCompleteView = initialView();
  staleCompleteView.signIn = { state: 'complete', expiresAt: new Date(Date.now() + 120000).toISOString() };
  await reset(staleCompleteView);
  await openAccount(page);
  await expect(page.getByText('Sign-in completed', { exact: true })).toBeVisible();
  await expect(page.locator('dl').getByText('Connected', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toBeVisible();

  await reset();
  failSignInOnce = true;
  await openAccount(page);
  await page.getByLabel('I authorize this installation to use my ChatGPT account for Native CollectiveUI.').check();
  const launchButton = page.getByRole('button', { name: 'Connect ChatGPT', exact: true });
  await launchButton.click();
  await expect(page.getByRole('alert')).toContainText('Synthetic companion launch service is unavailable.');
  await expect(launchButton).toBeEnabled();
  await launchButton.click();
  await expect(page.getByText('Waiting for the local sign-in app to finish…')).toBeVisible();
  expect(connectionActions.filter(call => call.action === 'begin-sign-in')).toHaveLength(2);
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();

  await reset();
  failPrepareOnce = true;
  await openAccount(page);
  await page.getByLabel('I authorize this installation to prepare my private Codex runtime. ChatGPT plan usage is authorized separately when I sign in.').check();
  await page.getByRole('button', { name: 'Prepare private runtime', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic broker preparation failure.');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByLabel('I authorize this installation to prepare my private Codex runtime. ChatGPT plan usage is authorized separately when I sign in.')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Prepare private runtime', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare private runtime', exact: true }).click();
  await expect(page.getByText('Prepared', { exact: true })).toBeVisible();
  expect(connectionActions.filter(call => call.action === 'prepare-runtime')).toHaveLength(2);

  const connectedView = initialView();
  connectedView.credential = { email: 'alice@example.test', planType: 'plus', status: 'active', migrationRequired: false };
  connectedView.backends.native = { state: 'connected' };
  connectedView.backends.codex = { state: 'not_connected' };
  connectedView.setup.runtime = { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' };
  await reset(connectedView);
  await openAccount(page);
  await expect(page.getByText('Prepared', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare private runtime', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enable stock Codex', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true })).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Enable stock Codex', exact: true }).click();
  await expect(page.locator('p').filter({ hasText: 'Stock Codex:' })).toHaveText('Stock Codex: connected');
  await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true })).toHaveCount(0);
  await expect(page.locator('p').filter({ hasText: 'Native CollectiveUI:' })).toHaveText('Native CollectiveUI: not_connected');
  expect(connectionActions.map(call => call.action)).toEqual(['sync-token', 'disconnect']);
  expect(connectionActions[0].body).toEqual({ action: 'sync-token' });
  expect(connectionActions[1].body).toEqual({ action: 'disconnect' });
  await noOverflow(page);

  await reset();
  failAccountRead = true;
  await page.goto(origin);
  await expect(page.getByRole('alert')).toContainText('Synthetic account service outage.');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ChatGPT account', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare private runtime', exact: true })).toBeDisabled();

  await reset();
  await page.goto(`${origin}/approval`);
  await expect(page.getByText('Codex wants to run a command')).toBeVisible();
  const denyCard = page.locator('section[aria-label="Approval fixtures"] > div').nth(0);
  const stopCard = page.locator('section[aria-label="Approval fixtures"] > div').nth(1);
  await denyCard.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect(denyCard.getByRole('status')).toHaveText('Denied');
  await stopCard.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(stopCard.getByRole('status')).toHaveText('Stopped');
  const approvalCalls = await page.evaluate(() => window.fixtureFetchCalls.filter(call => call.url.includes('/approvals/')));
  expect(approvalCalls).toEqual([
    { url: '/api/me/codex/approvals/approval-deny', method: 'POST', headers: { 'x-codex-decision': 'decline' }, body: null },
    { url: '/api/me/codex/approvals/approval-stop', method: 'POST', headers: { 'x-codex-decision': 'cancel' }, body: null },
  ]);
  expect(approvalActions).toEqual([{ id: 'approval-deny', decision: 'decline', body: '' }, { id: 'approval-stop', decision: 'cancel', body: '' }]);
  await noOverflow(page);
  expect(pageErrors).toEqual([]);
  console.log('PASS Unified ChatGPT and stock Codex setup: separate runtime/sign-in consent, exact safe launch payload, stubbed companion URI handoff, sanitized waiting/cancel/complete states, disabled-companion installer link, retry after broker/account failures, connected controls, fixed approval headers, and 320/390/768/1280 layouts. Synthetic endpoints only.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
