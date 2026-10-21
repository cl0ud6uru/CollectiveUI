import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-operations-browser-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React,{useState} from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client'; import { NativeOperations } from '${root}/src/components/hermes/native-operations'; function Fixture(){const [target,setTarget]=useState({id:'owned-session',profile:'default',title:'Fixture chat'}); return <><button onClick={()=>setTarget(target.id==='owned-session'?{id:'other-session',profile:'work',title:'Other fixture chat'}:{id:'owned-session',profile:'default',title:'Fixture chat'})}>Switch chat target</button><NativeOperations key={target.id+target.profile} connectionId="fixture" profiles={[{name:'default'},{name:'work'}]} nativeSession={target}/></>} createRoot(document.getElementById('root')!).render(<Fixture/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: {'@': path.join(root, 'src')} });
const requests = [];
let scheduleEnabled = true;
let scheduleState = 'scheduled';
let fileContent = 'Synthetic file before edit\n';
let pluginSelected = null;
let preparedPluginSelection;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  const request = { method: req.method, panel: url.searchParams.get('panel'), profile: url.searchParams.get('profile'), sessionId: url.searchParams.get('sessionId'), path: url.searchParams.get('path'), body: '' };
  requests.push(request);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST') {
    req.on('data', chunk => { request.body += chunk; });
    req.on('end', () => {
      const envelope = JSON.parse(request.body); request.input = envelope.input;
      request.sessionId = envelope.sessionId;
      if (envelope.input.operation === 'prepare') {
        preparedPluginSelection = envelope.input.action === 'plugin-selection' ? envelope.input.enabled : undefined;
        res.end(JSON.stringify({ confirmation: 'synthetic-confirmation', action: envelope.input.action === 'pause' || envelope.input.action === 'resume' ? 'schedule' : envelope.input.action,
          enabled: envelope.input.action === 'plugin-selection' ? envelope.input.enabled : envelope.input.action === 'resume', name: envelope.input.action === 'pause' || envelope.input.action === 'resume' ? 'Fixture schedule' : envelope.input.action === 'plugin-selection' ? 'teams_pipeline' : envelope.input.name, profile: 'default', title: 'Fixture chat', bytes: Buffer.byteLength(envelope.input.content || '') })); return;
      }
      if (preparedPluginSelection !== undefined) {
        pluginSelected = preparedPluginSelection; preparedPluginSelection = undefined;
        res.end(JSON.stringify({ accepted: true, pluginSelection: { name: 'teams_pipeline', selected: pluginSelected, operatorSelected: null, startupSelected: null, loadedState: 'unreported' }, output: 'Preference stored for local operator confirmation.' })); return;
      }
      if (envelope.input.operation === 'confirm-file-edit') { fileContent = envelope.input.content; res.end(JSON.stringify({ accepted: true, path: 'README.md', output: 'File saved and verified.' })); return; }
      if (requests.at(-2)?.input?.action === 'pause') { scheduleEnabled = false; scheduleState = 'paused'; }
      if (requests.at(-2)?.input?.action === 'resume') { scheduleEnabled = true; scheduleState = 'scheduled'; }
      res.end(JSON.stringify({ accepted: true, duplicate: false, schedules: [{ id: 's1', name: 'Fixture schedule', enabled: scheduleEnabled, state: scheduleState }, { id: 'done', name: 'Completed schedule', enabled: false, state: 'completed' }], projects: [{ id: 'p1', name: 'Fixture project', archived: false, folders: [{ path: '/workspace' }] }], activeId: '' }));
    });
    return;
  }
  const panel = url.searchParams.get('panel');
  if (url.searchParams.get('profile') === 'work' && url.searchParams.get('sessionId') !== 'other-session') { res.statusCode = 403; res.end(JSON.stringify({ error: 'Personal remote Hermes is disabled.' })); return; }
  const fixtures = {
    projects: { projects: [{ id: 'p1', name: 'Fixture project', archived: false, folders: [{ path: '/workspace' }] }] },
    schedules: { schedules: [{ id: 's1', name: 'Fixture schedule', enabled: scheduleEnabled, state: scheduleState, schedule: '0 7 * * *' }, { id: 'done', name: 'Completed schedule', enabled: false, state: 'completed', schedule: 'once' }] },
    plugins: { plugins: [{ name: 'Fixture plugin', version: '1.0', status: 'enabled' }] },
    'plugin-selection': { pluginSelection: { name: 'teams_pipeline', selected: pluginSelected, operatorSelected: null, startupSelected: null, loadedState: 'unreported' } },
    system: { version: 'Fixture version', cpuCount: 4, cpuPercent: 10, memory: { total: 1000, used: 500, percent: 50 } },
    files: url.searchParams.get('action') === 'read' ? { available: true, workspaceId: '0123456789abcdef0123456789abcdef', projectName: 'Synthetic project', action: 'read', path: 'README.md', content: fileContent, sha256: createHash('sha256').update(fileContent).digest('hex'), entries: [] } : { available: true, workspaceId: '0123456789abcdef0123456789abcdef', projectName: 'Synthetic project', action: 'list', path: '.', entries: [{ name: 'README.md', path: 'README.md', directory: false }, { name: 'src', path: 'src', directory: true }] },
  };
  res.end(JSON.stringify(fixtures[panel]));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HERMES_BROWSER_EXECUTABLE ? { executablePath: process.env.HERMES_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByText('Fixture project', { exact: false })).toBeVisible();
  await page.getByLabel('New project name').fill('Empty fixture project');
  await page.getByRole('button', { name: 'Review empty project creation' }).click();
  await expect(page.getByRole('button', { name: 'Confirm Hermes change' })).toBeVisible();
  expect(requests.filter(r => r.method === 'POST').map(r => r.input.operation)).toEqual(['prepare']);
  await expect(page.getByRole('region', { name: 'Confirm profile-wide Hermes change' })).toContainText('shared with other Hermes clients');
  await page.getByRole('button', { name: 'Confirm Hermes change' }).click();
  await expect.poll(() => requests.filter(r => r.method === 'POST').map(r => r.input.operation)).toEqual(['prepare', 'confirm']);
  expect(requests.filter(r => r.method === 'POST').map(r => r.input.action)).toEqual(['create', undefined]);
  await page.getByRole('button', { name: 'Directories', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByLabel('Edit README.md')).toHaveValue('Synthetic file before edit\n');
  await page.getByLabel('Edit README.md').fill('Unsaved draft from profile A\n');
  await page.getByRole('button', { name: 'Review save' }).click();
  await expect(page.getByRole('button', { name: 'Confirm file save' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Confirm workspace file save' })).toContainText('README.md');
  expect(requests.filter(r => r.method === 'POST').at(-1).input.operation).toBe('prepare');
  await page.getByRole('button', { name: 'Switch chat target', exact: true }).click();
  await expect(page.getByLabel('Hermes workspace profile')).toContainText('work');
  await page.getByRole('button', { name: 'Directories', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByLabel('Edit README.md')).toHaveValue('Synthetic file before edit\n');
  await expect(page.getByRole('button', { name: 'Confirm file save' })).toHaveCount(0);
  expect(requests.filter(r => r.method === 'POST').some(r => r.input.operation === 'confirm-file-edit')).toBe(false);
  expect(requests.some(r => r.profile === 'work' && r.sessionId === 'other-session' && r.path === 'README.md')).toBe(true);
  await page.getByRole('button', { name: 'Switch chat target', exact: true }).click();
  await expect(page.getByLabel('Hermes workspace profile')).toContainText('default');
  await page.getByRole('button', { name: 'Directories', exact: true }).click();
  await page.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.getByLabel('Edit README.md')).toHaveValue('Synthetic file before edit\n');
  await page.getByLabel('Edit README.md').fill('Reviewed browser edit\n');
  await page.getByRole('button', { name: 'Review save' }).click();
  await expect(page.getByRole('button', { name: 'Confirm file save' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm file save' }).click();
  await expect.poll(() => requests.filter(r => r.method === 'POST').map(r => r.input.operation)).toContain('confirm-file-edit');
  expect(requests.filter(r => r.method === 'POST' && r.input.operation === 'confirm-file-edit').at(-1).sessionId).toBe('owned-session');
  await expect(page.getByLabel('Edit README.md')).toHaveValue('Reviewed browser edit\n');
  await page.getByRole('button', { name: 'Schedules', exact: true }).click();
  await expect(page.getByText('Fixture schedule', { exact: false })).toBeVisible();
  await expect(page.locator('article').filter({ hasText: 'Completed schedule' }).getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review pause', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirm profile-wide Hermes change' })).toContainText('Pause schedule');
  expect(requests.filter(r => r.method === 'POST').slice(-1)[0].input.operation).toBe('prepare');
  await page.getByRole('button', { name: 'Confirm Hermes change', exact: true }).click();
  await expect.poll(() => requests.filter(r => r.method === 'POST').map(r => r.input.operation)).toContain('confirm');
  await expect(page.getByText('Enabled: no')).toBeVisible();
  await page.getByRole('button', { name: 'Review resume', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirm profile-wide Hermes change' })).toContainText('may run soon and use model usage');
  await page.getByRole('button', { name: 'Confirm Hermes change', exact: true }).click();
  await expect(page.getByText('Enabled: yes')).toBeVisible();
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.getByText('Fixture plugin', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Plugin preferences', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Plugin selection controls' })).toContainText('Runtime loaded state: unreported');
  await expect(page.getByText('Stored preference for teams_pipeline: follow native configuration.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review enable preference', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirm profile-wide Hermes change' })).toContainText('local operator confirmation');
  expect(pluginSelected).toBeNull();
  expect(requests.filter(r => r.method === 'POST').at(-1).input).toEqual({ operation: 'prepare', action: 'plugin-selection', enabled: true });
  await page.getByRole('button', { name: 'Confirm Hermes change', exact: true }).click();
  await expect(page.getByText('Stored preference for teams_pipeline: pending enabled.', { exact: true })).toBeVisible();
  await expect(page.getByText('Process-start selection: follow native configuration. This is not proof of loaded state.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review enable preference', exact: true })).toBeDisabled();
  expect(requests.some(r => r.panel === 'plugin-selection' && r.sessionId === 'owned-session')).toBe(true);
  expect(requests.filter(r => r.method === 'POST').some(r => ['enable-plugin', 'disable-plugin', 'toggle'].includes(r.input.action))).toBe(false);
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.getByText('Fixture version', { exact: true })).toBeVisible();
  await page.getByLabel('Hermes workspace profile').click(); await page.getByRole('option', { name: 'work', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('disabled');
  await expect(page.getByText('Fixture version', { exact: true })).toHaveCount(0);
  await page.getByLabel('Hermes workspace profile').click(); await page.getByRole('option', { name: 'default', exact: true }).click();
  await expect(page.getByText('Fixture version', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Fixture version', { exact: true })).toBeVisible();
  expect(requests.filter(r => r.method === 'GET').length).toBeGreaterThan(0);
  expect(requests.some(r => r.path === 'README.md')).toBe(true);
  expect(errors).toEqual([]);
  console.log('PASS: bound drafts/confirmations, two-step file/project/schedule controls, pending plugin preference with frozen startup/unreported loaded state, shared-profile warning, panel rendering and refresh; no browser errors.');
} finally { await browser?.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
