import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(tmpdir(), 'docker-sandboxes-admin-')));
const screenshotDir = process.env.SBX_SCREENSHOT_DIR ?? path.join(root, 'docs/screenshots/docker-sandboxes');
await mkdir(screenshotDir, { recursive: true });

const template = `registry.example.invalid/collectiveui/codex-computer@sha256:${'a'.repeat(64)}`;
const snapshot = {
  available: true, reason: null, checkedAt: '2026-10-14T12:00:00.000Z', backend: 'sbx', version: 'v0.48.0',
  checks: [
    { id: 'daemon', label: 'Sandbox daemon', state: 'passed', detail: 'Synthetic fixture · daemon responds' },
    { id: 'kvm', label: 'KVM access', state: 'passed', detail: 'Synthetic fixture · not a host attestation' },
    { id: 'template', label: 'Pinned image', state: 'unknown', detail: 'Synthetic fixture · image digest is illustrative' },
    { id: 'credential', label: 'Credential containment', state: 'failed', detail: 'Synthetic fixture · operator proof is intentionally unverified' },
  ],
  settings: { revision: 12, cpus: 4, memoryMb: 8192, maxRunning: 8, defaultTemplate: template, admittedOwners: ['fixture-owner-alex', 'fixture-owner-blair'] },
  runtimes: [
    { ownerId: 'fixture-owner-alex', admitted: true, state: 'running', cpus: 4, memoryMb: 8192, template, activeSessions: 1, credentialState: 'operator_unverified', computer: { available: false, paused: true, control: 'paused', lastFrameAt: null } },
    { ownerId: 'fixture-owner-blair', admitted: true, state: 'stopped', cpus: 4, memoryMb: 8192, template, activeSessions: 0, credentialState: 'sync_required', computer: { available: false, paused: false, control: 'unavailable', lastFrameAt: null } },
    { ownerId: 'fixture-owner-casey', admitted: false, state: 'missing', cpus: 4, memoryMb: 8192, template, activeSessions: 0, credentialState: 'operator_unverified', computer: { available: false, paused: false, control: 'unavailable', lastFrameAt: null } },
  ],
  templates: [
    { reference: template, label: 'Codex computer · synthetic', available: true, inUse: 2 },
    { reference: `registry.example.invalid/collectiveui/codex-base@sha256:${'b'.repeat(64)}`, label: 'Codex base · synthetic', available: null, inUse: 0 },
  ],
  archives: [{ name: 'codex-computer-fixture.tar', sizeBytes: 1024 * 1024 * 128 }],
  validation: [
    { id: 'sbx', result: 'passed', reference: 'fixture run #42', checkedAt: '2026-10-13T12:00:00.000Z', checkedBy: 'fixture-admin@example.invalid', template, source: 'operator' },
    { id: 'desktop', result: 'pending', reference: 'No live GUI proof', checkedAt: null, checkedBy: null, template, source: 'operator' },
    { id: 'containment', result: 'failed', reference: 'Synthetic fixture · not verified', checkedAt: '2026-10-13T12:00:00.000Z', checkedBy: 'fixture-admin@example.invalid', template, source: 'operator' },
    { id: 'inference', result: 'pending', reference: 'No authenticated inference proof', checkedAt: null, checkedBy: null, template, source: 'operator' },
  ],
  siwcSandboxVerified: false,
  people: [
    { id: 'fixture-owner-alex', name: 'Alex Fixture', email: 'alex@example.invalid', disabled: false },
    { id: 'fixture-owner-blair', name: 'Blair Fixture', email: 'blair@example.invalid', disabled: false },
    { id: 'fixture-owner-casey', name: 'Casey Fixture', email: 'casey@example.invalid', disabled: false },
  ],
};

const unavailable = { ...snapshot, available: false, reason: 'Synthetic fixture · broker unavailable; host state not observed', backend: 'unconfigured', version: null, checks: [], runtimes: [], templates: [], archives: [], validation: [], settings: { revision: 0, cpus: 2, memoryMb: 4096, maxRunning: 1, defaultTemplate: '', admittedOwners: [] } };

const actionKeys = {
  settings: ['action', 'revision', 'cpus', 'memoryMb', 'maxRunning', 'defaultTemplate'],
  enrollment: ['action', 'revision', 'ownerId', 'admitted'],
  lifecycle: ['action', 'ownerId', 'operation'],
  'template-add': ['action', 'revision', 'reference', 'label'],
  'template-remove': ['action', 'revision', 'reference'],
  'template-import': ['action', 'revision', 'archive', 'reference'],
  'network-add': ['action', 'ownerId', 'effect', 'destination'],
  'network-remove': ['action', 'ownerId', 'ruleId'],
  'network-check': ['action', 'ownerId', 'destination'],
  'network-read': ['action', 'ownerId'],
  diagnose: ['action'],
  validation: ['action', 'revision', 'id', 'result', 'reference'],
};
let actionRequests = [];
let nextError = false;
let delayOwnerRead = false;
let currentSnapshot = snapshot;
const networks = new Map();
const networkFor = (ownerId) => networks.get(ownerId) ?? {
  ownerId, rules: [], observed: true, note: `Synthetic network policy for ${ownerId}; not a live host signal.`,
  eventsObserved: true,
  events: [{ at: '2026-10-14T11:59:00.000Z', destination: 'docs.example.invalid:443', decision: 'allowed' }],
};
function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const entry = path.join(dir, 'entry.tsx');
const entryCode = `
import React from 'react';
import { createRoot } from '${root}/node_modules/react-dom/client';
import { DockerSandboxesAdmin } from '${root}/src/components/admin/docker-sandboxes-admin';
function App() {
  const params = new URLSearchParams(location.search);
  const initial = ['unavailable', 'read-error'].includes(params.get('state')) ? ${JSON.stringify(unavailable)} : params.get('state') === 'partial' ? { ...${JSON.stringify(snapshot)}, runtimes: ${JSON.stringify(snapshot)}.runtimes.map(runtime => ({ ...runtime, state: 'unavailable' })) } : params.get('state') === 'empty'
    ? { ...${JSON.stringify(snapshot)}, runtimes: [], templates: [], archives: [], validation: [], settings: { ...${JSON.stringify(snapshot)}.settings, admittedOwners: [] } }
    : params.get('state') === 'denied'
      ? { ...${JSON.stringify(snapshot)}, available: false, reason: 'Synthetic fixture · access denied', checks: [], runtimes: [], templates: [], archives: [], validation: [], settings: { ...${JSON.stringify(snapshot)}.settings, admittedOwners: [] } }
      : ${JSON.stringify(snapshot)};
  return <div><div role="alert" style={{margin:'12px auto',maxWidth:1440,padding:'9px 14px',borderRadius:12,background:'#7c2d12',color:'white',fontSize:12,fontWeight:700}}>SYNTHETIC ADMIN FIXTURE · fabricated users and sandbox state · no host operations</div><DockerSandboxesAdmin initialData={initial} /></div>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
await writeFile(entry, entryCode);
const bundle = await build({
  entryPoints: [entry], bundle: true, write: false, outdir: dir, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') },
  plugins: [{
    name: 'fixture-admin-actions',
    setup(build) {
      build.onResolve({ filter: /docker-sandboxes\/actions$/ }, () => ({ path: 'fixture-admin-actions', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export async function readDockerSandboxes() {
          const response = await fetch('/fixture/read' + location.search, { cache: 'no-store' });
          if (!response.ok) throw new Error('Synthetic read failed');
          return response.json();
        }
        export async function performDockerSandboxAction(action) {
          const response = await fetch('/fixture/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
          const data = await response.json();
          if (!response.ok) return { ok: false, error: data.error || 'Synthetic action failed' };
          return { ok: true, ...data };
        }
      `, loader: 'js' }));
    },
  }],
});
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'src/app/globals.css'), 'utf8'), { from: path.join(root, 'src/app/globals.css') });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles.find(file => file.path.endsWith('.js')).contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); return; }
  if (url.pathname === '/fixture/error' && req.method === 'POST') { nextError = true; json(res, { ok: true }); return; }
  if (url.pathname === '/fixture/delay-network' && req.method === 'POST') { delayOwnerRead = true; json(res, { ok: true }); return; }
  if (url.pathname === '/fixture/read') {
    if (['read-error', 'refresh-error'].includes(url.searchParams.get('state'))) { json(res, { error: 'Synthetic read failed' }, 503); return; }
    json(res, url.searchParams.get('state') === 'unavailable' ? unavailable : { ...currentSnapshot }); return;
  }
  if (url.pathname === '/fixture/action' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    let action;
    try { action = JSON.parse(raw); } catch { json(res, { error: 'Invalid synthetic JSON' }, 400); return; }
    if (!action || !actionKeys[action.action]) { json(res, { error: 'Unknown synthetic action' }, 400); return; }
    const expectedKeys = action.action === 'lifecycle' && action.operation === 'delete' ? [...actionKeys.lifecycle, 'confirmation'] : actionKeys[action.action];
    if (Object.keys(action).sort().join('|') !== [...expectedKeys].sort().join('|')) { json(res, { error: `Invalid synthetic ${action.action} contract shape` }, 400); return; }
    actionRequests.push(action);
    if (nextError) { nextError = false; json(res, { error: 'Synthetic fixture · operation unavailable' }, 503); return; }
    if (action.action === 'network-read') {
      if (delayOwnerRead && action.ownerId === 'fixture-owner-alex') { delayOwnerRead = false; await new Promise(resolve => setTimeout(resolve, 700)); }
      json(res, { result: { message: 'Synthetic network policy loaded.', network: networkFor(action.ownerId) }, data: currentSnapshot }); return;
    }
    if (action.action === 'network-add') {
      const network = networkFor(action.ownerId);
      const rule = { id: `00000000-0000-4000-8000-${String(network.rules.length + 1).padStart(12, '0')}`, ownerId: action.ownerId, effect: action.effect, destination: action.destination, createdAt: '2026-10-14T12:00:00.000Z' };
      const updated = { ...network, rules: [...network.rules, rule] }; networks.set(action.ownerId, updated);
      json(res, { result: { message: 'Synthetic network rule added.', network: updated }, data: currentSnapshot }); return;
    }
    if (action.action === 'network-remove') {
      const network = networkFor(action.ownerId);
      const updated = { ...network, rules: network.rules.filter(rule => rule.id !== action.ruleId) }; networks.set(action.ownerId, updated);
      json(res, { result: { message: 'Synthetic network rule removed.', network: updated }, data: currentSnapshot }); return;
    }
    if (action.action === 'network-check') {
      json(res, { result: { message: 'Synthetic network check complete.', network: networkFor(action.ownerId), networkCheck: { destination: action.destination, decision: action.destination.includes('blocked') ? 'denied' : 'allowed', detail: 'Synthetic policy evaluation only; no packet was sent.' } }, data: currentSnapshot }); return;
    }
    if (action.action === 'diagnose') {
      json(res, { result: { message: 'Synthetic diagnostic finished.', diagnostics: { checkedAt: '2026-10-14T12:00:00.000Z', checks: currentSnapshot.checks, source: 'host', liveComputerUseVerified: false } }, data: currentSnapshot }); return;
    }
    if (action.action === 'enrollment' && action.ownerId === 'fixture-owner-casey' && action.admitted) {
      const casey = currentSnapshot.runtimes.find(runtime => runtime.ownerId === action.ownerId) ?? snapshot.runtimes.find(runtime => runtime.ownerId === action.ownerId);
      currentSnapshot = {
        ...currentSnapshot,
        settings: { ...currentSnapshot.settings, admittedOwners: [...new Set([...currentSnapshot.settings.admittedOwners, action.ownerId])] },
        runtimes: currentSnapshot.runtimes.some(runtime => runtime.ownerId === action.ownerId)
          ? currentSnapshot.runtimes.map(runtime => runtime.ownerId === action.ownerId ? { ...runtime, admitted: true } : runtime)
          : [...currentSnapshot.runtimes, { ...casey, admitted: true }],
      };
    }
    json(res, { result: { message: `Synthetic ${action.action} recorded; no host state changed.` }, data: currentSnapshot }); return;
  }
  if (url.pathname === '/' && url.searchParams.get('state') === 'stale-owner') delayOwnerRead = true;
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${address}/?state=stale-owner`);
  await expect(page.getByRole('alert').first()).toContainText('SYNTHETIC ADMIN FIXTURE');
  await expect(page.getByRole('heading', { name: 'Docker Sandboxes' })).toBeVisible();
  const tablist = page.getByRole('tablist', { name: 'Computer administration sections' });
  const choose = async (label, optionName) => { await page.getByLabel(label).click(); await page.getByRole('option', { name: optionName, exact: true }).click(); };
  await expect(tablist.getByRole('tab')).toHaveCount(5);
  await expect(page.getByText('Credential containment', { exact: true })).toBeVisible();
  await expect(page.getByText('operator unverified', { exact: true })).toBeVisible();
  // Capture the real component with explicitly fabricated records and zero host access.
  await page.screenshot({ path: path.join(screenshotDir, 'admin-overview-light-desktop.png'), fullPage: true });
  await page.locator('html').evaluate(el => el.classList.replace('light', 'dark'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(screenshotDir, 'admin-overview-dark-desktop.png'), fullPage: true });

  // Activate a section by keyboard and exercise every template action.
  const templatesTab = tablist.getByRole('tab', { name: 'Templates' });
  await templatesTab.focus(); await page.keyboard.press('Enter');
  await expect(templatesTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Templates' })).toBeVisible();
  await page.getByRole('button', { name: 'Save default template' }).click();
  await page.getByLabel('Template name').fill('Synthetic imported browser');
  await page.getByLabel('Pinned image reference').first().fill(`registry.example.invalid/test/browser@sha256:${'c'.repeat(64)}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await choose('Host inbox archive', 'codex-computer-fixture.tar · 128.0 MB');
  await page.getByLabel('Pinned image reference').last().fill(`registry.example.invalid/test/imported@sha256:${'d'.repeat(64)}`);
  await expect(page.getByRole('button', { name: 'Import archive' })).toBeEnabled();
  await page.getByRole('button', { name: 'Import archive' }).click();
  await expect(page.getByRole('status')).toContainText('Synthetic template-import recorded');
  await page.getByRole('button', { name: 'Remove approved template Codex base · synthetic' }).click();
  await expect.poll(() => actionRequests.map(action => action.action)).toEqual(expect.arrayContaining(['settings', 'template-add', 'template-import', 'template-remove']));

  // Resource limits and enrollment submit their revision-bound action shapes.
  await tablist.getByRole('tab', { name: 'Resources' }).click();
  await page.getByLabel('CPU cores').fill('6');
  await page.getByLabel('Memory (MB)').fill('12288');
  await page.getByLabel('Maximum running').fill('12');
  await page.getByRole('button', { name: 'Save resource defaults' }).click();
  await tablist.getByRole('tab', { name: 'Access & validation' }).click();
  await page.getByRole('button', { name: 'Admit owner' }).last().click();
  await choose('Area', 'Isolation');
  await choose('Result', 'Pending');
  await page.getByLabel('Evidence reference').fill('fixture://review/containment');
  await page.getByRole('button', { name: 'Save operator validation' }).click();
  expect(actionRequests.map(action => action.action)).toEqual(expect.arrayContaining(['enrollment', 'validation']));
  await page.screenshot({ path: path.join(screenshotDir, 'admin-access-dark-desktop.png'), fullPage: true });

  // A delayed read for the previous owner must not overwrite the selected owner's policy.
  await tablist.getByRole('tab', { name: 'Network' }).click();
  await choose('Choose computer owner', 'Blair Fixture · blair@example.invalid');
  await expect(page.getByText(/Synthetic network policy for fixture-owner-blair/)).toBeVisible();
  await page.evaluate(() => fetch('/fixture/delay-network', { method: 'POST' }));
  await choose('Choose computer owner', 'Alex Fixture · alex@example.invalid');
  await expect(page.getByText('Loading owner policy…')).toBeVisible();
  await choose('Choose computer owner', 'Blair Fixture · blair@example.invalid');
  await expect(page.getByText(/Synthetic network policy for fixture-owner-blair/)).toBeVisible();
  await page.waitForTimeout(850);
  await expect(page.getByText(/Synthetic network policy for fixture-owner-blair/)).toBeVisible();
  await choose('Rule', 'Deny');
  await page.getByLabel('Host or IP address').fill('blocked.example.invalid:443');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('blocked.example.invalid:443')).toBeVisible();
  await page.getByLabel('Check a destination').fill('blocked.example.invalid:443');
  await page.getByRole('button', { name: 'Check policy' }).click();
  await expect(page.locator('p[role="status"]').filter({ hasText: 'blocked.example.invalid:443' })).toContainText('denied');
  await page.getByRole('button', { name: 'Remove deny rule for blocked.example.invalid:443' }).click();
  expect(actionRequests.map(action => action.action)).toEqual(expect.arrayContaining(['network-read', 'network-add', 'network-check', 'network-remove']));

  // Server errors are surfaced without being mistaken for a successful host change.
  await page.evaluate(() => fetch('/fixture/error', { method: 'POST' }));
  await page.getByLabel('Check a destination').fill('docs.example.invalid');
  await page.getByRole('button', { name: 'Check policy' }).click();
  await expect(page.locator('[role="alert"]').filter({ hasText: 'Synthetic fixture · operation unavailable' })).toBeVisible();

  // Owner lifecycle controls, including the explicit destructive confirmation.
  await tablist.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: /Casey Fixture/ }).click();
  await page.getByRole('button', { name: 'Provision', exact: true }).click();
  await page.getByRole('button', { name: /Blair Fixture/ }).click();
  await page.getByRole('button', { name: 'Start computer' }).click();
  await page.getByRole('button', { name: /Alex Fixture/ }).click();
  await page.getByRole('button', { name: 'Stop computer' }).click();
  await page.getByRole('button', { name: 'Delete computer' }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete computer and data?' });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByLabel('Type DELETE to confirm').fill('DELETE');
  await deleteDialog.getByRole('button', { name: 'Delete computer' }).click();
  expect(actionRequests.filter(action => action.action === 'lifecycle').map(action => action.operation)).toEqual(['provision', 'start', 'stop', 'delete']);

  // The diagnostics dialog is keyboard-dismissible and exports the sanitized report.
  await page.getByRole('button', { name: 'Diagnostics' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sanitized host diagnostics' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('live computer use verified: no');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download report' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^computer-diagnostics-/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(actionRequests.map(action => action.action)).toContain('diagnose');

  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('status')).toContainText('Host and owner inventory refreshed.');
  const empty = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await empty.goto(`${address}/?state=empty`);
  await expect(empty.getByText(/No computers are registered yet/)).toBeVisible();
  await empty.getByRole('tab', { name: 'Templates' }).click();
  await expect(empty.getByText(/No approved templates yet/)).toBeVisible();
  const denied = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await denied.goto(`${address}/?state=denied`);
  await expect(denied.getByText('SBX status unavailable', { exact: true })).toBeVisible();
  await expect(denied.getByRole('button', { name: 'Diagnostics' })).toBeEnabled();
  await expect(denied.getByRole('button', { name: 'Delete computer' })).toHaveCount(0);

  // Unobserved data never becomes a zero count or a green refresh confirmation.
  const unavailablePage = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  unavailablePage.on('pageerror', error => errors.push(error.message));
  await unavailablePage.goto(`${address}/?state=unavailable`);
  await expect(unavailablePage.getByText('Backend unknown', { exact: true })).toBeVisible();
  await expect(unavailablePage.getByText('Unknown', { exact: true })).toHaveCount(3);
  await expect(unavailablePage.getByText('No current host checks', { exact: true })).toBeVisible();
  await expect(unavailablePage.getByText(/No computers are registered yet/)).toHaveCount(0);
  await expect(unavailablePage.locator('a[href="/admin/sandboxes"]')).toHaveCount(0);
  await unavailablePage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(unavailablePage.getByRole('alert').last()).toContainText('Host inventory could not be verified.');
  await expect(unavailablePage.getByText('Host and owner inventory refreshed.')).toHaveCount(0);
  await unavailablePage.screenshot({ path: path.join(screenshotDir, 'admin-unavailable-light-desktop.png'), fullPage: true });
  await unavailablePage.getByRole('button', { name: 'Open SBX host setup', exact: true }).click();
  const setup = unavailablePage.getByRole('dialog', { name: 'SBX host setup', exact: true });
  await expect(setup).toBeVisible();
  await expect(setup).toContainText('v0.48.0');
  await expect(setup).toContainText('/dev/kvm');
  await expect(setup).toContainText('PERSONAL_CODEX_SOCKET');
  await expect(setup).toContainText('Deploying CollectiveUI does not install SBX');
  await expect(setup.getByRole('link', { name: 'Full SBX deployment runbook' })).toHaveAttribute('href', /docs\/deploy\/computer-view\.md$/);
  await unavailablePage.screenshot({ path: path.join(screenshotDir, 'admin-sbx-setup-light-desktop.png'), fullPage: true });
  await unavailablePage.keyboard.press('Escape');
  await expect(setup).toBeHidden();
  // Expected unavailable diagnostics errors stay in the page with usable controls.
  await unavailablePage.request.post(`${address}/fixture/error`);
  await unavailablePage.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await expect(unavailablePage.getByRole('alert').last()).toContainText('Synthetic fixture · operation unavailable');
  await expect(unavailablePage.getByRole('dialog')).toHaveCount(0);
  await expect(unavailablePage.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  for (const name of ['Templates', 'Network', 'Resources', 'Access & validation']) {
    await unavailablePage.getByRole('tab', { name, exact: true }).click();
    await expect(unavailablePage.getByRole('tabpanel')).toContainText('Host settings and inventory are unavailable.');
    await expect(unavailablePage.getByText('Current defaults:', { exact: false })).toHaveCount(0);
  }
  const partial = await browser.newPage();
  await partial.goto(`${address}/?state=partial`);
  const running = partial.getByText('Computers running', { exact: true }).locator('..');
  await expect(running).toContainText('Unknown');
  await expect(partial.getByText('Some host availability unknown', { exact: true })).toBeVisible();
  await partial.getByRole('tab', { name: 'Resources', exact: true }).click();
  await expect(partial.getByText('Running', { exact: true }).locator('..')).toContainText('Unknown');
  const readFailure = await browser.newPage();
  await readFailure.goto(`${address}/?state=refresh-error`);
  await expect(readFailure.getByText("Connected", { exact: true })).toBeVisible();
  await readFailure.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(readFailure.getByRole('alert').last()).toContainText('Synthetic read failed');
  await expect(readFailure.getByText('Unknown', { exact: true })).toHaveCount(3);
  await expect(readFailure.getByText('Backend unknown', { exact: true })).toBeVisible();
  await expect(readFailure.getByText('Host and owner inventory refreshed.')).toHaveCount(0);
  await unavailablePage.setViewportSize({ width: 390, height: 844 });
  await unavailablePage.getByRole('tab', { name: 'Overview', exact: true }).click();
  await unavailablePage.locator('html').evaluate(el => el.classList.replace('light', 'dark'));
  await unavailablePage.screenshot({ path: path.join(screenshotDir, 'admin-unavailable-dark-mobile.png'), fullPage: true });
  await unavailablePage.getByRole('button', { name: 'SBX setup help', exact: true }).click();
  await expect(setup).toBeVisible();
  await setup.getByRole('link', { name: 'Full SBX deployment runbook' }).scrollIntoViewIfNeeded();
  await expect(setup.getByRole('link', { name: 'Full SBX deployment runbook' })).toBeInViewport();
  await setup.evaluate(element => { element.scrollTop = 0; });
  expect(await unavailablePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await unavailablePage.screenshot({ path: path.join(screenshotDir, 'admin-sbx-setup-dark-mobile.png'), fullPage: true });
  await unavailablePage.keyboard.press('Escape');

  expect(actionRequests.map(action => action.action)).toEqual(expect.arrayContaining([
    'settings', 'enrollment', 'lifecycle', 'template-add', 'template-remove', 'template-import',
    'network-add', 'network-remove', 'network-check', 'network-read', 'diagnose', 'validation',
  ]));

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(address);
  const mobileTabs = mobile.getByRole('tablist', { name: 'Computer administration sections' });
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mobile.screenshot({ path: path.join(screenshotDir, 'admin-overview-light-mobile.png'), fullPage: true });
  await mobileTabs.getByRole('tab', { name: 'Access & validation' }).focus();
  await mobile.keyboard.press('Enter');
  await expect(mobile.getByRole('tab', { name: 'Access & validation' })).toBeInViewport();
  await mobile.locator('html').evaluate(el => el.classList.replace('light', 'dark'));
  await mobile.waitForTimeout(300);
  await mobileTabs.getByRole('tab', { name: 'Network' }).click();
  await mobile.waitForTimeout(200);
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mobile.screenshot({ path: path.join(screenshotDir, 'admin-network-dark-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
  for (const name of ['admin-overview-light-desktop.png', 'admin-overview-dark-desktop.png', 'admin-access-dark-desktop.png', 'admin-overview-light-mobile.png', 'admin-network-dark-mobile.png']) await chmod(path.join(screenshotDir, name), 0o644);
  console.log(`PASS: synthetic admin fixture covered ${actionRequests.length} strict action requests, stale owner responses, empty/denied/error states, keyboard and mobile responsiveness. Captures: ${screenshotDir}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
