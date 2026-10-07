import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild'), { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'remote-command-ui-'));
const helper = await build({ entryPoints: [path.join(root, 'src/lib/remote-hermes/commands.ts')], write: false, bundle: true, platform: 'node', format: 'esm' });
const { nativeCommandCatalog } = await import(`data:text/javascript;base64,${Buffer.from(helper.outputFiles[0].contents).toString('base64')}`);
const contract = JSON.parse(await readFile(path.join(root, 'tests/fixtures/remote-hermes-command-contract.json'), 'utf8'));
const catalog = nativeCommandCatalog({ ...contract.catalog, pairs: [...contract.catalog.pairs, ['/fixture-skill', 'Prepare a fixture task']], skills: { '/fixture-skill': { usage: 0, origin: 'local' } } });
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react';import {createRoot} from '${root}/node_modules/react-dom/client';import {NativeWorkspace} from '${root}/src/components/hermes/native-workspace';createRoot(document.getElementById('root')).render(<NativeWorkspace connectionId="fixture" profiles={[{name:'default'}]} saved={[{id:'session',storedId:'stored',title:'Fixture chat',profile:'default',status:'idle'},{id:'second',storedId:'second-stored',title:'Second fixture chat',profile:'default',status:'idle'}]} allowed={true} initialSession="session" initialError=""/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{ name: 'fixture-link', setup(b) { b.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`, loader: 'jsx', resolveDir: root })); } }] });
let running = false, failure = false, lost = false, oldVersion = false, release;
let yoloAllowed = false, effectiveBypass = false, approvalMode = 'manual', runtimeVersion = '0.21.5', yoloTtl = 60000, yoloLost = false;
const yoloTokens = new Map(), yoloReceipts = new Set(); let yoloSequence = 0;
const received = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') {
    const op = url.searchParams.get('operation');
    if (op === 'catalog') res.end(JSON.stringify(oldVersion ? nativeCommandCatalog(null) : catalog));
    else if (op === 'browse') res.end(JSON.stringify({ sessions: [], linked: [{ id: 'session', storedId: 'stored', title: 'Fixture chat', profile: 'default', status: 'idle' }, { id: 'second', storedId: 'second-stored', title: 'Second fixture chat', profile: 'default', status: 'idle' }] }));
    else if (url.pathname.endsWith('/administration')) res.end(JSON.stringify({ mcp: { available: false }, plugins: { available: false }, cron: { available: false }, operations: [] }));
    else res.end(JSON.stringify({ id: url.searchParams.get('sessionId') || 'session', title: url.searchParams.get('sessionId') === 'second' ? 'Second fixture chat' : 'Fixture chat', profile: 'default', running, uncertain: false, connection: 'connected', messages: [], partial: '', tools: [], prompts: [], model: 'Fixture model', provider: 'Fixture', usage: {}, queued: '', queuePending: false, admissionAllowed: true, yolo: effectiveBypass, approvalMode, yoloAllowed, runtimeVersion, desktopContract: 8, nativeProfile: 'default' }));
    return;
  }
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const input = JSON.parse(Buffer.concat(bytes).toString()); received.push(input);
  if (url.pathname.endsWith('/yolo')) {
    if (input.input.operation === 'prepare') { const confirmation = `synthetic-confirmation-${++yoloSequence}`; yoloTokens.set(confirmation, input.input.value); res.end(JSON.stringify({ confirmation, value: input.input.value, expiresAt: Date.now() + yoloTtl, profile: 'default', title: input.sessionId === 'second' ? 'Second fixture chat' : 'Fixture chat', effectiveBypass, approvalMode })); return; }
    const confirmation = input.input.confirmation;
    if (yoloReceipts.has(confirmation)) { if (yoloLost) res.destroy(); else res.end(JSON.stringify({ duplicate: true, output: 'This YOLO confirmation was already submitted. It will not be replayed.' })); return; }
    yoloReceipts.add(confirmation); const value = yoloTokens.get(confirmation); effectiveBypass = value === 'on' || approvalMode === 'off';
    if (yoloLost) { res.destroy(); return; }
    res.end(JSON.stringify({ accepted: true, sessionValue: value, effectiveBypass, approvalMode, output: `Session YOLO flag set ${value.toUpperCase()}. Effective approval bypass: ${effectiveBypass ? 'ON' : 'OFF'}.${value === 'off' && effectiveBypass ? ' Bypass remains active: inherited profile/process settings are unchanged.' : ''}` })); return;
  }
  if (input.operation === 'command' && input.text === '/version' && lost) { res.destroy(); return; }
  if (input.operation === 'command' && input.text === '/help' && release === 'hold') await new Promise(resolve => { release = resolve; });
  if (failure) { res.statusCode = 502; res.end(JSON.stringify({ error: 'This Hermes version does not support that feature.' })); return; }
  if (input.operation === 'command' && input.text.startsWith('/fixture-skill')) res.end(JSON.stringify({ output: 'Skill loaded. Review the draft.', prefill: 'Reviewable skill task' }));
  else { if (input.text === '/stop') running = false; res.end(JSON.stringify({ output: input.text === '/yolo' ? 'Hermes YOLO: OFF. CollectiveUI cannot change approval bypass.' : `Native result for ${input.text}\nRuntime warning` })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  for (const mobile of [false, true]) {
    received.length = 0; running = failure = lost = oldVersion = false;
    yoloAllowed = effectiveBypass = yoloLost = false; approvalMode = 'manual'; runtimeVersion = '0.21.5'; yoloTtl = 60000; yoloTokens.clear(); yoloReceipts.clear();
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/hermes/fixture?session=session`);
    const box = page.getByRole('textbox', { name: 'Message Hermes' });
    await expect(box).toBeVisible();
    await box.fill('Keep this unsent draft');
    await page.getByRole('button', { name: 'Commands & skills' }).click();
    await expect(page.getByRole('button', { name: '/yolo Inspect YOLO' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search Hermes commands' }).fill('compress');
    await page.getByRole('textbox', { name: 'Search Hermes commands' }).press('Enter');
    await expect(box).toHaveValue('Keep this unsent draft'); expect(received).toHaveLength(0);
    await box.fill(''); await page.getByRole('button', { name: 'Commands & skills' }).click();
    await expect(page.getByRole('button', { name: /^\/compress / })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^\/status / })).toHaveCount(0);
    await page.getByRole('button', { name: /^\/compress / }).click();
    await expect(box).toHaveValue('/compress '); expect(received).toHaveLength(0);
    await page.getByRole('button', { name: 'Commands & skills' }).click();
    await page.getByRole('textbox', { name: 'Search Hermes commands' }).fill('version');
    await page.getByRole('textbox', { name: 'Search Hermes commands' }).press('Enter');
    await expect(box).toHaveValue('/compress '); expect(received).toHaveLength(0);
    await box.fill('/ver'); await box.press('Tab'); await expect(box).toHaveValue('/version ');
    await box.press('Enter'); await expect(page.getByText('Native result for /version', { exact: false })).toBeVisible();
    await box.fill('/yolo'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('effective approval bypass: OFF');
    await expect(dialog.getByRole('button', { name: 'Enable session YOLO…' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(box).toHaveValue('/yolo');
    await box.fill('/yolo on'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Session changes are unavailable'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(box).toHaveValue('/yolo on');
    yoloAllowed = true; await page.getByRole('button', { name: 'Approval mode', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Enable session YOLO…' })).toBeEnabled(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true })).toBeVisible(); await expect(dialog).toContainText('Other native clients sharing this conversation');
    expect(received.at(-1).input.operation).toBe('prepare'); const confirmedBeforeCancel = received.filter(r => r.input?.operation === 'confirm').length;
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(received.filter(r => r.input?.operation === 'confirm')).toHaveLength(confirmedBeforeCancel); await expect(box).toHaveValue('/yolo on');
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(box).toHaveValue('');
    await expect(page.getByText('Hermes effective approval bypass is active', { exact: true })).toBeVisible(); expect(received.at(-1).input.operation).toBe('confirm');
    approvalMode = 'off'; await box.fill('/yolo off'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm session YOLO OFF', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Bypass remains active:', { exact: false })).toBeVisible(); await expect(page.getByText('Hermes effective approval bypass is active', { exact: true })).toBeVisible();
    yoloTtl = 300; await box.fill('/yolo on'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(dialog.getByText('Confirmation expired.', { exact: false })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true })).toBeDisabled(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); yoloTtl = 60000;
    yoloLost = true; await page.getByRole('button', { name: 'Run command', exact: true }).click(); await dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible(); const lostToken = received.at(-1).input.confirmation;
    yoloLost = false; await dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(received.at(-1).input.confirmation).toBe(lostToken); expect(yoloReceipts.has(lostToken)).toBe(true);
    runtimeVersion = '0.21.4'; await page.getByRole('button', { name: 'Approval mode', exact: true }).click(); await expect(dialog.getByText('This runtime is unavailable for changes.', { exact: false })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Enable session YOLO…' })).toBeDisabled(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    runtimeVersion = '0.21.5'; effectiveBypass = false; approvalMode = 'manual';
    await box.fill('Keep this ordinary draft'); await page.getByLabel('Attach files to Hermes').setInputFiles({ name: 'keep-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic draft attachment') });
    await page.getByRole('button', { name: 'Approval mode', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Disable session YOLO…' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Disable session YOLO…' }).click(); await dialog.getByRole('button', { name: 'Confirm session YOLO OFF', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(box).toHaveValue('Keep this ordinary draft'); await expect(page.getByText('keep-draft.txt', { exact: true })).toBeVisible(); await page.getByLabel('Attach files to Hermes').setInputFiles([]);
    await box.fill('/yolo on'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true })).toBeVisible(); const departedToken = [...yoloTokens.keys()].at(-1); await dialog.press('Escape');
    await page.getByRole('button', { name: 'Second fixture chat', exact: true }).click(); await expect(box).toHaveValue(''); await page.getByRole('button', { name: 'Approval mode', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true })).toHaveCount(0); await dialog.getByRole('button', { name: 'Enable session YOLO…' }).click();
    await expect(dialog.getByRole('button', { name: 'Confirm session YOLO ON', exact: true })).toBeVisible(); await expect(dialog).toContainText('Second fixture chat'); expect(received.at(-1).sessionId).toBe('second'); expect([...yoloTokens.keys()].at(-1)).not.toBe(departedToken); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Fixture chat', exact: true }).click(); await expect(box).toHaveValue('');
    const beforeShell = received.length;
    await box.fill('!yolo'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('CLI shell syntax'); expect(received).toHaveLength(beforeShell);
    await box.fill('/help'); await box.press('Escape');
    await page.getByLabel('Attach files to Hermes').setInputFiles({ name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('draft and files have been kept'); await expect(box).toHaveValue('/help'); expect(received).toHaveLength(beforeShell);
    await page.getByLabel('Attach files to Hermes').setInputFiles([]);
    await box.fill('/fixture-skill task'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(box).toHaveValue('Reviewable skill task'); await expect(page.getByText('Skill loaded. Review the draft.', { exact: true })).toBeVisible();
    expect(received.at(-1).operation).toBe('command'); expect(received.some(r => r.operation === 'submit')).toBe(false);
    failure = true; await box.fill('/help'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('does not support'); await expect(box).toHaveValue('/help');
    failure = false; release = 'hold';
    const count = received.length;
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    await box.press('Enter'); expect(received.length).toBe(count + 1);
    release(); release = undefined; await expect(box).toHaveValue('');
    lost = true; await box.fill('/version'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible(); await expect(box).toHaveValue('/version');
    const uncertainId = received.at(-1).requestId;
    lost = false; await page.getByRole('button', { name: 'Run command', exact: true }).click(); await expect(box).toHaveValue('');
    expect(received.at(-1).requestId).toBe(uncertainId);
    running = true; await expect(page.getByRole('button', { name: 'Steer current turn' })).toBeVisible();
    await box.fill('/yolo on'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click(); await expect(dialog).toContainText('Finish pending prompts'); await expect(dialog.getByRole('button', { name: 'Enable session YOLO…' })).toBeDisabled(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await box.fill('/ctx'); await box.press('Escape'); await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Run command', exact: true }).click(); await expect(box).toHaveValue(''); expect(received.at(-1).text).toBe('/ctx');
    await box.fill('/compress'); await box.press('Escape'); await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeDisabled();
    await box.fill('/stop'); await box.press('Escape'); await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible(); expect(received.at(-1).text).toBe('/stop');
    await box.fill('/tmp/path'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(box).toHaveValue(''); expect(received.at(-1).operation).toBe('submit');
    await box.fill('//help'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(box).toHaveValue(''); expect(received.at(-1)).toMatchObject({ operation: 'submit', text: '//help' });
    oldVersion = true; await page.getByRole('button', { name: 'Commands & skills' }).click(); await expect(page.getByText('This Hermes version does not provide a compatible command catalog.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /^\/compress / })).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/collective-hermes-commands-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
    await page.close();
  }
  console.log('PASS: pinned catalog menu on desktop/mobile, typed commands, keyboard/search, confirmed session YOLO on/off, cancellation/expiry, inherited bypass, default-off/version/active gates, draft/files and switched-session preservation, lost confirmation receipts, skill prefill, errors, repeated actions, active controls and literals. Synthetic HTTP only.');
} finally { if (typeof release === 'function') release(); await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
