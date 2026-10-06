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
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-operations-browser-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client'; import { NativeOperations } from '${root}/src/components/hermes/native-operations'; createRoot(document.getElementById('root')!).render(<NativeOperations connectionId="fixture" profiles={[{name:'default'},{name:'work'}]}/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: {'@': path.join(root, 'src')} });
const requests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  requests.push({ method: req.method, panel: url.searchParams.get('panel'), profile: url.searchParams.get('profile'), path: url.searchParams.get('path') });
  res.setHeader('Content-Type', 'application/json');
  const panel = url.searchParams.get('panel');
  if (url.searchParams.get('profile') === 'work') { res.statusCode = 403; res.end(JSON.stringify({ error: 'Personal remote Hermes is disabled.' })); return; }
  const fixtures = {
    projects: { projects: [{ id: 'p1', name: 'Fixture project', archived: false, folders: [{ path: '/workspace' }] }] },
    schedules: { schedules: [{ id: 's1', name: 'Fixture schedule', enabled: true, schedule: '0 7 * * *' }] },
    plugins: { plugins: [{ name: 'Fixture plugin', version: '1.0', status: 'enabled' }] },
    system: { version: 'Fixture version', cpuCount: 4, cpuPercent: 10, memory: { total: 1000, used: 500, percent: 50 } },
    files: { roots: ['/workspace'], directory: url.searchParams.get('path') || '/workspace', entries: url.searchParams.get('path') === '/workspace/src' ? [{ name: 'example.ts', path: '/workspace/src/example.ts', directory: false }] : [{ name: 'src', path: '/workspace/src', directory: true }] },
  };
  res.end(JSON.stringify(fixtures[panel]));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByText('Fixture project', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Directories', exact: true }).click();
  await page.getByRole('button', { name: 'src/', exact: true }).click();
  await expect(page.getByText('example.ts', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Parent directory' }).click();
  await expect(page.getByRole('button', { name: 'src/', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Schedules', exact: true }).click();
  await expect(page.getByText('Fixture schedule', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.getByText('Fixture plugin', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.getByText('Fixture version', { exact: true })).toBeVisible();
  await page.getByLabel('Hermes workspace profile').click(); await page.getByRole('option', { name: 'work', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('disabled');
  await expect(page.getByText('Fixture version', { exact: true })).toHaveCount(0);
  await page.getByLabel('Hermes workspace profile').click(); await page.getByRole('option', { name: 'default', exact: true }).click();
  await expect(page.getByText('Fixture version', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Fixture version', { exact: true })).toBeVisible();
  expect(requests.every(r => r.method === 'GET')).toBe(true);
  expect(requests.some(r => r.path === '/workspace/src')).toBe(true);
  expect(errors).toEqual([]);
  console.log('PASS: projects, directory descent/parent, schedules, plugins, system, profile switch, disablement, refresh; GET-only and no browser errors.');
} finally { await browser?.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
