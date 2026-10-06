import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

// No application server, account, native runtime or model calls: real components, synthetic callbacks.
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-team-ui-'));
const entry = path.join(dir, 'entry.tsx');
const longPath = `skills/fixture/${'very-long-package-name-'.repeat(12)}/SKILL.md`;
await writeFile(entry, `
import React, { useState } from 'react';
import { createRoot } from '${root}/node_modules/react-dom/client';
import { HermesTeamControls } from '${root}/src/components/chat/hermes-team-controls';
import { HermesTeamPolicy } from '${root}/src/components/bots/hermes-team-policy';
const base = { enabled: true, mode: 'member', canMaintain: false, state: 'ready', installedRevision: 2, publishedRevision: 2, conflictCount: 0 };
window.fixtureCalls = []; window.fixtureFailOpen = false; window.fixtureFailPublish = false; window.fixtureHoldPublish = false;
window.fixtureSource = { snapshotId: 'stable-snapshot', expectedRevision: 2, capturedAt: '2026-10-06T00:00:00Z', resources: [
  { id: 'procedure', name: 'Useful procedure', kind: 'skill', change: 'changed', files: [
    { path: ${JSON.stringify(longPath)}, diff: '- Previous procedure\\n+ Reviewed useful procedure' },
    { path: 'scripts/helper.py', after: '<script>window.fixtureExecuted = true</script>' },
    { path: 'assets/icon.png', binary: true },
  ] },
  { id: 'old', name: 'Old procedure', kind: 'skill', change: 'removed', files: [{ path: 'SKILL.md', before: 'Old content' }] }
] };
function App() {
  const [view, setView] = useState(base); const [busy, setBusy] = useState(false); const [supported, setSupported] = useState(true);
  const [conversation, setConversation] = useState('private-conversation');
  const [policy, setPolicy] = useState({ enabled: false, modelPolicy: 'admin_provided', maintainerIds: [] });
  window.fixtureStatus = next => setView(v => ({ ...v, ...next })); window.fixtureBusy = setBusy; window.fixtureSupported = setSupported;
  const open = async mode => { window.fixtureCalls.push({ operation: 'open', mode }); if (window.fixtureFailOpen) throw new Error('Synthetic permission rejection.'); setConversation(mode === 'admin' ? 'admin-conversation' : 'private-conversation'); setView(v => ({ ...v, mode })); };
  const capture = async () => { window.fixtureCalls.push({ operation: 'capture' }); return structuredClone(window.fixtureSource); };
  const publish = async input => { window.fixtureCalls.push({ operation: 'publish', ...input }); if (window.fixtureHoldPublish) await new Promise(resolve => { window.fixtureReleasePublish = resolve; }); if (window.fixtureFailPublish) { window.fixtureFailPublish = false; throw new Error('Publication result not confirmed.'); } return { revision: 3 }; };
  const conflicts = async () => [{ id: 'deleted', name: 'Deleted procedure', memberDeleted: true, memberFiles: [], teamFiles: [{ path: 'SKILL.md', after: 'Team content' }] }, { id: 'modified', name: 'Changed procedure', teamRemoved: true, memberFiles: [{ path: 'SKILL.md', after: 'My private correction' }], teamFiles: [] }];
  const resolve = async input => { window.fixtureCalls.push({ operation: 'resolve', ...input }); };
  return <main className="mx-auto max-w-3xl p-2">
    <div data-testid="conversation">{conversation}</div>
    <HermesTeamControls key={conversation} view={view} busy={busy} onOpenMode={supported ? open : undefined} onCapture={supported ? capture : undefined} onPublish={supported ? publish : undefined} onLoadConflicts={supported ? conflicts : undefined} onResolveConflict={supported ? resolve : undefined}/>
    <HermesTeamPolicy value={policy} onChange={setPolicy} maintainers={[{id:'admin',name:'Fixture admin'}, {id:'disabled',name:'Disabled admin',disabled:true}]} modelOptions={[{value:'admin_provided',available:true},{value:'personal_required',available:false,reason:'Not verified'}]}/>
    <pre data-testid="policy" className="whitespace-pre-wrap break-all">{JSON.stringify(policy)}</pre>
  </main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') } });
const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
const css = await postcss([tailwind({ base: root })]).process(globals, { from: path.join(root, 'src/app/globals.css') });
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); return; }
  res.setHeader('Content-Type', 'text/html'); res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByRole('region', { name: 'Hermes Team Bot controls' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Admin mode' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.fixtureStatus({ canMaintain: true }));
  const mode = page.getByRole('switch', { name: 'Admin mode' });
  await page.evaluate(() => { window.fixtureFailOpen = true; });
  await mode.click(); await expect(page.getByRole('alert')).toHaveText('Synthetic permission rejection.');
  await expect(mode).not.toBeChecked(); await expect(page.getByTestId('conversation')).toHaveText('private-conversation');
  await page.evaluate(() => { window.fixtureFailOpen = false; });
  await mode.check(); await expect(page.getByTestId('conversation')).toHaveText('admin-conversation');
  await expect(mode).toBeChecked();
  await page.evaluate(() => window.fixtureBusy(true));
  await expect(mode).toBeDisabled(); await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toBeDisabled();
  await page.evaluate(() => window.fixtureBusy(false));
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Publish changes' }); await expect(review).toBeVisible();
  await expect(review.getByRole('checkbox', { name: 'Publish Useful procedure' })).not.toBeChecked();
  await expect(review.getByRole('checkbox', { name: 'Publish Old procedure' })).not.toBeChecked();
  await expect(review.getByRole('button', { name: 'Publish 0 items' })).toBeDisabled();
  await review.getByText(longPath, { exact: true }).click(); await expect(review.getByText('- Previous procedure\n+ Reviewed useful procedure', { exact: true })).toBeVisible();
  await review.getByText('scripts/helper.py', { exact: true }).click();
  await expect(review.getByText('<script>window.fixtureExecuted = true</script>', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixtureExecuted)).toBeUndefined();
  await review.getByRole('checkbox', { name: 'Publish Useful procedure' }).check();
  await review.getByLabel('Team release note').fill('Share the useful procedure only.');
  await page.evaluate(() => { window.fixtureSource.resources[0].files[0].diff = 'Unreviewed later learning'; window.fixtureFailPublish = true; window.fixtureHoldPublish = true; });
  await review.getByRole('button', { name: 'Publish 1 item' }).click();
  await expect(review.getByRole('button', { name: 'Publish 1 item' })).toBeDisabled(); await expect(page.getByRole('switch', { name: 'Admin mode', includeHidden: true })).toBeDisabled();
  await page.evaluate(() => window.fixtureReleasePublish());
  await expect(review.getByRole('alert')).toHaveText('Publication result not confirmed.');
  await expect(review.getByLabel('Team release note')).toBeDisabled();
  await expect(review.getByRole('checkbox', { name: 'Publish Useful procedure' })).toBeDisabled();
  await expect(review.getByText('Unreviewed later learning', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.fixtureHoldPublish = false; });
  await review.getByRole('button', { name: 'Retry publish' }).click(); await expect(review).toHaveCount(0);
  const calls = await page.evaluate(() => window.fixtureCalls); const publishes = calls.filter(call => call.operation === 'publish');
  expect(publishes).toHaveLength(2); expect(publishes[0]).toEqual(publishes[1]);
  expect(publishes[0]).toMatchObject({ snapshotId: 'stable-snapshot', expectedRevision: 2, resourceIds: ['procedure'], releaseNote: 'Share the useful procedure only.' });
  expect(publishes[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  await mode.uncheck(); await expect(page.getByTestId('conversation')).toHaveText('private-conversation');
  await page.evaluate(() => window.fixtureStatus({ canMaintain: false, conflictCount: 2 }));
  await page.getByRole('button', { name: 'Review 2 updates' }).click();
  const conflictDialog = page.getByRole('dialog', { name: 'Review team updates' });
  const deleted = conflictDialog.getByRole('region', { name: 'Update Deleted procedure' });
  await expect(deleted.getByText('You deleted this item. Keep my version preserves that choice.')).toBeVisible();
  await deleted.getByRole('button', { name: 'Keep my version' }).click(); await expect(deleted).toHaveCount(0);
  const modified = conflictDialog.getByRole('region', { name: 'Update Changed procedure' });
  await modified.getByText('Preview your version').click(); await modified.getByText('SKILL.md', { exact: true }).click();
  await expect(modified.getByText('My private correction', { exact: true })).toBeVisible();
  await modified.getByRole('button', { name: 'Use team version' }).click();
  await expect(conflictDialog.getByText('All updates have been reviewed.')).toBeVisible(); await conflictDialog.getByRole('button', { name: 'Done' }).click();
  expect((await page.evaluate(() => window.fixtureCalls)).filter(call => call.operation === 'resolve').map(call => [call.conflictId, call.choice])).toEqual([['deleted', 'keep_mine'], ['modified', 'use_team']]);
  await page.evaluate(() => { window.fixtureSupported(false); window.fixtureStatus({ mode: 'admin', canMaintain: true }); });
  await expect(page.getByText('Publishing is not available in this version. Native learning continues in the working bot.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.fixtureSupported(true); window.fixtureStatus({ state: 'connection_needed' }); });
  await expect(page.getByRole('button', { name: 'Publish changes', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await page.evaluate(() => window.fixtureStatus({ state: 'revoked' }));
  await expect(mode).toBeDisabled();
  await expect(page.getByText('Your access to this Team Bot was removed. Ask an admin if you need access again.')).toBeVisible();
  await page.evaluate(() => window.fixtureStatus({ state: 'ready' }));
  await page.getByRole('button', { name: 'Publish changes', exact: true }).click(); await expect(review).toBeVisible();
  await review.getByText(longPath, { exact: true }).click();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.fixtureStatus({ canMaintain: false })); await expect(review).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Share a Hermes Team Bot', exact: false }).check();
  await page.getByRole('checkbox', { name: 'Maintainer: Fixture admin', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Maintainer: Disabled admin', exact: true })).toBeDisabled();
  await page.getByLabel('Team Bot model access').click();
  await expect(page.getByRole('option', { name: 'Personal ChatGPT required', exact: true })).toHaveAttribute('data-disabled');
  await page.keyboard.press('Escape');
  expect(JSON.parse(await page.getByTestId('policy').textContent())).toEqual({ enabled: true, modelPolicy: 'admin_provided', maintainerIds: ['admin'] });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.fixtureStatus({ enabled: false })); await expect(page.getByRole('region', { name: 'Hermes Team Bot controls' })).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('PASS: member/admin authorization hints, separate mode navigation, active-work controls, immutable package review, escaped code, stable publish retry, modified/deleted conflict choices, unverified model choices, compatible states and 320–1280px layouts; no model/runtime calls or browser errors.');
} finally { await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
