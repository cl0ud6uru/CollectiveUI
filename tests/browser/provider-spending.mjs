import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'provider-spending-'));
let browser, server, releaseRefresh;
const fixtureAccounts = () => {
  const now = new Date();
  const limit = { status: 'known', amount: 100, currency: 'USD', enforcement: 'enforcing' };
  const snapshot = {
    organization: 'org-fixture', month: now.toISOString().slice(0, 7), start: 1,
    through: Math.floor(now.getTime() / 1000), refreshedAt: now.toISOString(), costsStatus: 'known',
    amounts: [{ currency: 'USD', value: 95 }],
    daily: [1, 2, 3].map(day => ({
      start: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day) / 1000,
      end: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day + 1) / 1000,
      amounts: [{ currency: 'USD', value: day / 100 }],
    })),
    breakdownStatus: 'known', projects: [{ id: 'proj-fixture-one', amounts: [{ currency: 'USD', value: 2 }] }, { id: 'proj-fixture-two', amounts: [{ currency: 'USD', value: 93 }] }],
    organizationLimit: limit, projectLimits: { 'proj-fixture-one': { ...limit, amount: 50 }, 'proj-fixture-two': { ...limit, amount: 200 } },
  };
  return [{ id: 'one', name: 'Fixture billing', organization: 'org-fixture', enabled: true, showHealthBar: false, snapshot, lastAttemptAt: null, lastError: null },
    { id: 'two', name: 'Disabled fixture', organization: 'org-disabled', enabled: false, showHealthBar: false, snapshot: null, lastAttemptAt: null, lastError: null },
    { id: 'three', name: 'Second enabled fixture', organization: 'org-fixture-other', enabled: true, showHealthBar: false, snapshot: { ...snapshot, organization: 'org-fixture-other', amounts: [{ currency: 'USD', value: 25 }] }, lastAttemptAt: null, lastError: null }];
};
let refreshMode = 'http-error';
const refreshes = [], saves = [];
try {
  const entry = path.join(dir, 'entry.tsx');
  await writeFile(entry, `import React from 'react';import{createRoot}from'${root}/node_modules/react-dom/client';import{SpendingDashboard}from'${root}/src/components/admin/spending-dashboard';
    const accounts=${JSON.stringify(fixtureAccounts())};
    if(['/stale','/auto','/hidden'].includes(location.pathname))accounts[0].snapshot.refreshedAt='2020-01-01';
    if(location.pathname==='/permissions')accounts[0].snapshot.breakdownStatus='permission_denied';
    if(location.pathname==='/unavailable'){accounts[0].snapshot.organizationLimit={status:'unavailable',amount:null,currency:null,enforcement:null,httpStatus:404};accounts[0].snapshot.projectLimits={};}
    if(location.pathname==='/unsupported')accounts[0].snapshot.organizationLimit={status:'unsupported',amount:null,currency:null,enforcement:null,httpStatus:501};
    createRoot(document.getElementById('root')).render(<SpendingDashboard initial={location.pathname==='/empty'?[]:accounts}/>);`);
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{ name: 'fixture-actions', setup(b) {
    b.onResolve({ filter: /spending\/actions$/ }, () => ({ path: 'actions', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function saveBillingConfiguration(input){const {adminKey,...safe}=input;await fetch('/save',{method:'POST',body:JSON.stringify(input)});return {...safe,id:input.id??'new',snapshot:null,lastAttemptAt:null,lastError:null};}`, loader: 'js' }));
  } }] });
  const css = await require('postcss')([require('@tailwindcss/postcss')({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });
  server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); return; }
    if (req.url === '/save') { const chunks = []; for await (const c of req) chunks.push(c); saves.push(JSON.parse(Buffer.concat(chunks))); res.end('{}'); return; }
    if (req.url === '/api/admin/spending/refresh') {
      const chunks = []; for await (const c of req) chunks.push(c); const request = JSON.parse(Buffer.concat(chunks)); refreshes.push(request);
      const mode = refreshMode;
      if (mode.startsWith('slow-')) await new Promise(resolve => { releaseRefresh = resolve; });
      res.setHeader('Content-Type', 'application/json');
      if (mode.endsWith('http-error')) { res.statusCode = 500; res.end(JSON.stringify({ error: 'Fixture refresh failed' })); return; }
      const accounts = fixtureAccounts(); const account = accounts.find(a => a.id === request.id); account.lastAttemptAt = new Date().toISOString();
      if (mode === 'provider-error') { account.snapshot.refreshedAt = '2020-01-01'; account.lastError = 'Costs permission denied. Last successful data is retained.'; }
      else if (mode.endsWith('known-success')) account.snapshot.amounts = [{ currency: 'USD', value: 96 }];
      else { account.snapshot.amounts = [{ currency: 'USD', value: 1.6 }]; account.snapshot.organizationLimit = { status: 'unavailable', amount: null, currency: null, enforcement: null, httpStatus: 404 }; }
      res.end(JSON.stringify(accounts)); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html class="dark"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><body style="background:var(--bg);color:var(--fg)"><main style="padding:16px;max-width:1100px;margin:auto"><div id="root"></div></main><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(process.argv.includes('--serve') ? 4198 : 0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (process.argv.includes('--serve')) { console.log(`Synthetic provider dashboard preview: ${base}`); await new Promise(resolve => process.on('SIGINT', resolve)); }
  else {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    const out = process.env.SPENDING_SCREENSHOT_DIR ?? path.join(root, 'docs/screenshots/provider-spending'); await mkdir(out, { recursive: true });
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 960 }); await page.goto(base);
      await page.getByRole('combobox', { name: 'Spending scope' }).selectOption('proj-fixture-one');
      await expect(page.getByText('Parent organization limit', { exact: true })).toBeVisible(); await expect(page.getByText('USD 5.00', { exact: true })).toBeVisible();
      await expect(page.getByText('USD 48.00', { exact: true })).not.toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // With a largest daily cost of only three cents, its bar still fills the track.
      await expect(page.locator('[style="width: 100%;"]')).toHaveCount(1);
      if (width === 390 || width === 1280) await page.screenshot({ path: path.join(out, `dashboard-${width}.png`), fullPage: true });
      await page.getByRole('combobox', { name: 'Billing account' }).selectOption('two');
      await expect(page.getByText('Provider spending is disabled.', { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Refresh provider data' })).toBeDisabled();
    }
    // The actual regression: an HTTP 200 containing a retained stale snapshot must never claim success.
    refreshMode = 'provider-error'; const beforeFailure = refreshes.length;
    await page.goto(`${base}/stale`);
    await expect(page.getByRole('status')).toHaveText('Refresh did not update provider costs. Any previous snapshot is retained below.');
    await expect(page.getByRole('alert')).toContainText('Costs permission denied');
    await expect(page.getByText('Stale snapshot.', { exact: false })).toBeVisible();
    expect(refreshes.length).toBe(beforeFailure + 1);
    await expect(page.getByRole('button', { name: /Refresh in/ })).toBeDisabled();
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    expect(refreshes.length).toBe(beforeFailure + 1);
    // A slow automatic refresh shows loading, prevents duplicates, and publishes fresh costs separately from limits.
    refreshMode = 'slow-success'; await page.goto(`${base}/auto`);
    await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Reading provider data');
    await expect(page.getByRole('combobox', { name: 'Billing account' })).toBeDisabled();
    await expect.poll(() => typeof releaseRefresh).toBe('function'); releaseRefresh();
    await expect(page.getByRole('status')).toHaveText('Provider costs updated. Limit availability is reported separately below.');
    await expect(page.getByText('USD 1.60', { exact: true })).toBeVisible();
    await expect(page.getByText('Stale snapshot.', { exact: false })).not.toBeVisible();
    await expect(page.getByText('OpenAI did not expose this limit', { exact: false })).toBeVisible();
    await page.screenshot({ path: path.join(out, 'refreshed-1280.png'), fullPage: true });
    // Background pages do not read the provider. Returning to the visible page triggers one due refresh.
    refreshMode = 'success'; const hiddenPage = await browser.newPage();
    await hiddenPage.addInitScript(() => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }));
    const beforeHidden = refreshes.length; await hiddenPage.goto(`${base}/hidden`);
    await expect(hiddenPage.getByText('Stale snapshot.', { exact: false })).toBeVisible(); expect(refreshes.length).toBe(beforeHidden);
    await hiddenPage.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(hiddenPage.getByText('USD 1.60', { exact: true })).toBeVisible(); expect(refreshes.length).toBe(beforeHidden + 1); await hiddenPage.close();
    // A page left open becomes due again and refreshes on focus, without waiting for a browser timer.
    const beforeFocus = refreshes.length;
    await page.evaluate(() => { const observed = Date.now(); Date.now = () => observed + 6 * 60_000; window.dispatchEvent(new Event('focus')); });
    await expect.poll(() => refreshes.length).toBe(beforeFocus + 1);
    await page.goto(`${base}/unavailable`);
    await expect(page.getByText('does not mean no limit is set', { exact: false })).toBeVisible();
    await page.getByRole('combobox', { name: 'Spending scope' }).selectOption('proj-fixture-one');
    await expect(page.getByText('No limit was read for this project.', { exact: false })).toBeVisible();
    await page.goto(`${base}/unsupported`); await expect(page.getByText('Unsupported', { exact: true })).toBeVisible();
    await page.goto(`${base}/permissions`); await expect(page.getByText('Project breakdown permission denied.', { exact: false })).toBeVisible();
    refreshMode = 'http-error'; await page.getByRole('button', { name: 'Refresh provider data' }).click();
    await expect(page.getByRole('alert')).toHaveText('Fixture refresh failed');
    await expect(page.getByText('USD 5.00', { exact: true })).not.toBeVisible();
    // A failed read makes only its account uncertain, including after switching away and back.
    await page.goto(base);
    await expect(page.getByText('USD 5.00', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh provider data' }).click();
    await expect(page.getByRole('alert')).toHaveText('Fixture refresh failed');
    await page.getByRole('combobox', { name: 'Billing account' }).selectOption('three');
    await expect(page.getByText('USD 75.00', { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).not.toBeVisible();
    await page.getByRole('combobox', { name: 'Billing account' }).selectOption('one');
    await expect(page.getByRole('alert')).toHaveText('Fixture refresh failed');
    await expect(page.getByText('USD 5.00', { exact: true })).not.toBeVisible();
    // A successful B refresh returns all cached accounts, but cannot clear A's uncertainty.
    refreshMode = 'known-success';
    await page.getByRole('combobox', { name: 'Billing account' }).selectOption('three');
    await page.getByRole('button', { name: 'Refresh provider data' }).click();
    await expect(page.getByText('USD 4.00', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Billing account' }).selectOption('one');
    await expect(page.getByRole('alert')).toHaveText('Fixture refresh failed');
    await page.getByRole('combobox', { name: 'Spending scope' }).selectOption('proj-fixture-one');
    await expect(page.getByText('Remaining: Unknown', { exact: false })).toBeVisible();
    // Retrying cannot restore current allowance while pending, or after another failed request.
    const advanceCooldown = () => page.evaluate(() => { const observed = Date.now(); Date.now = () => observed + 61_000; });
    await advanceCooldown(); refreshMode = 'slow-http-error'; releaseRefresh = undefined;
    await page.getByRole('button', { name: 'Refresh provider data' }).click();
    await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveText('Fixture refresh failed');
    await expect(page.getByText('USD 5.00', { exact: true })).not.toBeVisible();
    await expect(page.getByText('Remaining: Unknown', { exact: false })).toBeVisible();
    await expect.poll(() => typeof releaseRefresh).toBe('function'); releaseRefresh();
    await expect(page.getByRole('status')).not.toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('Fixture refresh failed');
    await expect(page.getByText('USD 5.00', { exact: true })).not.toBeVisible();
    // Only A's own verified successful refresh clears the failure and restores allowance.
    await advanceCooldown(); refreshMode = 'slow-known-success'; releaseRefresh = undefined;
    await page.getByRole('button', { name: 'Refresh provider data' }).click();
    await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    await expect(page.getByText('USD 5.00', { exact: true })).not.toBeVisible();
    await expect(page.getByText('Remaining: Unknown', { exact: false })).toBeVisible();
    await expect.poll(() => typeof releaseRefresh).toBe('function'); releaseRefresh();
    await expect(page.getByRole('status')).toHaveText('Provider costs updated. Limit availability is reported separately below.');
    await expect(page.getByRole('alert')).not.toBeVisible();
    await expect(page.getByText('USD 4.00', { exact: true })).toBeVisible();
    await expect(page.getByText('Remaining: USD 4.00', { exact: false })).toBeVisible();
    await page.goto(`${base}/empty`); await page.getByText('Billing configuration', { exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Enable provider spending reads' })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Show admin spending bar beside model selection' })).not.toBeChecked();
    await page.getByRole('textbox', { name: 'Account label' }).fill('Fixture account'); await page.getByRole('textbox', { name: 'Organization ID' }).fill('org-fixture');
    await page.getByLabel('Separate API Platform Admin billing key', { exact: true }).fill('sk-admin-synthetic'); await page.getByRole('button', { name: 'Save billing configuration' }).click();
    await expect(page.getByText('Billing configuration saved.', { exact: true })).toBeVisible(); expect(saves.at(-1)).toMatchObject({ enabled: false, showHealthBar: false });
    await expect(page.getByLabel('Separate API Platform Admin billing key', { exact: true }).first()).toHaveValue('');
    expect(refreshes.every(r => r.id === 'one' || r.id === 'three')).toBe(true); expect(errors).toEqual([]);
    console.log('Provider dashboard passed: 320/390/768/1280 layouts; relative cent-scale bars; automatic/focus/visible refresh; loading and cooldown; retained failure vs success; per-account switch/retry uncertainty and successful recovery; independent unavailable/unsupported limits; disabled accounts and synthetic key form.');
  }
} finally {
  releaseRefresh?.(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true });
}
