import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real account and approval components, backed only by synthetic HTTP fixtures.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'personal-codex-browser-'));
const entry = path.join(dir, 'entry.tsx');
const connectionView = { state: 'not_started' };
const connectionActions = [];
const approvalActions = [];

await writeFile(entry, `
import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client';
import { PersonalCodexConnection } from '${root}/src/components/settings/personal-codex-connection';
import { CodexApproval } from '${root}/src/components/chat/codex-approval';
window.fixtureFetchCalls=[];
const originalFetch=window.fetch.bind(window);
window.fetch=(input,init={})=>{
  const url=String(input);
  if(url.startsWith('/api/me/codex')) window.fixtureFetchCalls.push({url,method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),body:init.body??null});
  return originalFetch(input,init);
};
const approval=location.pathname==='/approval';
createRoot(document.getElementById('root')).render(<main className="mx-auto max-w-2xl space-y-5 p-4 text-fg">
  <PersonalCodexConnection />
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
  const url = new URL(req.url, 'http://fixture.test');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); return; }
  if (url.pathname === '/__reset' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    for (const key of Object.keys(connectionView)) delete connectionView[key];
    Object.assign(connectionView, JSON.parse(body)); connectionActions.length = 0; approvalActions.length = 0; return json(res, { ok: true });
  }
  if (url.pathname === '/api/me/codex' && req.method === 'GET') return json(res, connectionView);
  if (url.pathname === '/api/me/codex' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const action = JSON.parse(body).action; connectionActions.push({ action, body });
    if (action === 'connect') Object.assign(connectionView, { state: 'pending', login: { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } });
    else if (action === 'confirm') Object.assign(connectionView, { state: 'connected', email: 'alice@example.invalid', workspaceId: 'workspace-owned', planType: 'business', canConnect: true });
    else if (action === 'cancel') Object.assign(connectionView, { state: 'signed_out', login: undefined });
    else if (action === 'disconnect') Object.assign(connectionView, { state: 'stopped', email: undefined, workspaceId: undefined, planType: undefined, login: undefined });
    else if (action === 'start') Object.assign(connectionView, { state: 'signed_out' });
    return json(res, connectionView);
  }
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
const pageErrors = [];
async function reset(view) {
  await fetch(`${origin}/__reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(view) });
}
async function noOverflow(page, widths = [320, 390, 768, 1280]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}px`).toBe(true);
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  page.on('pageerror', error => pageErrors.push(error.message));

  await reset({ state: 'not_started' });
  await page.goto(origin);
  await expect(page.getByRole('status').first()).toContainText('Connect your ChatGPT account');
  await page.getByRole('button', { name: 'Connect ChatGPT', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Finish sign-in on OpenAI');
  await expect(page.getByText('ABCD-EFGH')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open ChatGPT sign-in' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  Object.assign(connectionView, { state: 'confirm', email: 'alice@example.invalid', workspaceId: 'workspace-owned', planType: 'business' });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Confirm the signed-in account');
  await expect(page.getByRole('button', { name: 'Confirm my account', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm my account', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Connected for all of your Codex bots');
  await expect(page.getByText('alice@example.invalid · business · Workspace workspace-owned')).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);
  await expect(page.getByText(/endpoint|token/i)).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(window.fixtureFetchCalls))).not.toMatch(/AUTH|token|endpoint/i);
  await noOverflow(page);
  await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Your private workspace is retained');
  await expect(page.getByText('alice@example.invalid')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureFetchCalls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).action)))
    .toEqual(['connect', 'confirm', 'disconnect']);

  await reset({ state: 'uncertain' });
  await page.goto(origin);
  await expect(page.getByRole('status').first()).toContainText('prior native sign-in may still be active');
  await expect(page.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('runtime is ready to connect');
  expect(await page.evaluate(() => window.fixtureFetchCalls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).action))).toEqual(['cancel']);

  await reset({ state: 'connected', email: 'alice@example.invalid', workspaceId: 'workspace-owned', planType: 'business', canConnect: false });
  await page.goto(origin);
  await expect(page.getByText('New personal ChatGPT connections are disabled by your organization.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm my account', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true })).toBeVisible();
  await noOverflow(page);

  await reset({ state: 'signed_out', email: 'alice@example.invalid', workspaceId: 'workspace-owned', planType: 'business' });
  await page.goto(origin);
  await expect(page.getByText('Native sign-in ended. Disconnect the saved connection before signing in again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect ChatGPT', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect ChatGPT', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Your private workspace is retained');

  await reset({ state: 'not_started' });
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
  console.log('PASS Personal Codex connection and approval components: connect/pending/confirm/disconnect, uncertain cancel, policy-disabled metadata, fixed approval headers, and 320/390/768/1280 layouts. Synthetic endpoints only.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
