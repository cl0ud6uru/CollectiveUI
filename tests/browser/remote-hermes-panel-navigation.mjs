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
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-navigation-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react';
import {createRoot} from '${root}/node_modules/react-dom/client';
import {NativeWorkspace} from '${root}/src/components/hermes/native-workspace';
import {NativeOperations} from '${root}/src/components/hermes/native-operations';
const url = new URL(location.href);
const sessions = [{id:'session-a',storedId:'stored-a',title:'Chat A',profile:'default',status:'idle'},{id:'session-b',storedId:'stored-b',title:'Chat B',profile:'default',status:'idle'}];
const operations = url.pathname.endsWith('/operations');
const sessionId = url.searchParams.get('session');
const nativeSession = sessions.find(s => s.id === sessionId);
createRoot(document.getElementById('root')!).render(operations
 ? <NativeOperations connectionId="fixture" profiles={[{name:'default'}]} nativeSession={nativeSession ? {id:nativeSession.id,profile:nativeSession.profile,title:nativeSession.title} : null}/>
 : <NativeWorkspace connectionId="fixture" profiles={[{name:'default'}]} saved={sessions} allowed={true} initialSession={sessionId} initialError=""/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src') }, plugins: [{ name: 'fixture-link', setup(build) { build.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`, loader: 'jsx', resolveDir: root })); } }] });
const sent = [];
const chatTitle = new Map([['session-a', 'Chat A'], ['session-b', 'Chat B']]);
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') {
    if (url.pathname === '/api/hermes/fixture/administration') {
      res.end(JSON.stringify({ profileName: 'default', session: { reasoning: { supported: false, value: '' }, fast: { supported: false, value: '' } }, profile: { reasoning: { supported: false, value: '' }, fast: { supported: false, value: '' } }, mcp: null })); return;
    }
    if (url.pathname.endsWith('/operations')) {
      res.end(JSON.stringify({ projects: [{ id: 'project-a', slug: 'project-a', name: 'Project A', folders: [], archived: false }, { id: 'project-b', slug: 'project-b', name: 'Project B', folders: [], archived: false }], activeId: 'project-a' })); return;
    }
    const operation = url.searchParams.get('operation');
    if (operation === 'browse') { res.end(JSON.stringify({ sessions: [], linked: [{ id: 'session-a', storedId: 'stored-a', title: 'Chat A', profile: 'default', status: 'idle' }, { id: 'session-b', storedId: 'stored-b', title: 'Chat B', profile: 'default', status: 'idle' }] })); return; }
    if (operation === 'snapshot') { const id = url.searchParams.get('sessionId'); res.end(JSON.stringify({ id, title: chatTitle.get(id) ?? 'Synthetic chat', profile: 'default', running: false, uncertain: false, connection: 'connected', messages: [], partial: '', tools: [], prompts: [], model: 'Fixture model', provider: 'Fixture', usage: {}, queued: '', queuePending: false, admissionAllowed: true })); return; }
    if (operation === 'catalog') { res.end(JSON.stringify({ commands: [], aliases: {} })); return; }
    res.end('{}'); return;
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); sent.push(input);
  res.end(JSON.stringify({ confirmation: 'synthetic-confirmation', action: 'select', name: 'Project B', profile: 'default', title: chatTitle.get(input.sessionId) ?? 'Unknown chat' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/hermes/fixture`);
  await page.getByRole('link', { name: 'Workspace panels' }).click();
  await expect(page.getByText('Open a saved Hermes chat first to enable confirmed project changes.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review as active project' }).first()).toBeDisabled();
  await page.goto(`${base}/hermes/fixture`);
  await page.getByRole('button', { name: 'Chat A', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chat A' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Workspace panels' })).toHaveAttribute('href', '/hermes/fixture/operations?session=session-a');
  await page.getByRole('button', { name: 'Chat B', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chat B' })).toBeVisible();
  const link = page.getByRole('link', { name: 'Workspace panels' });
  await expect(link).toHaveAttribute('href', '/hermes/fixture/operations?session=session-b');
  await link.click();
  await expect(page.getByText('Confirmed changes are available only for the selected chat’s profile', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review as active project' }).last()).toBeEnabled();
  await page.getByRole('button', { name: 'Review as active project' }).last().click();
  await expect(page.getByText(/reviewed from chat “Chat B”/)).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ sessionId: 'session-b', input: { operation: 'prepare', action: 'select', projectId: 'project-b' } });
  expect(errors).toEqual([]);
  console.log('PASS: actual NativeWorkspace selection updates the panel link; empty, Chat A→B switching, panel navigation and project prepare all bind to the currently selected saved-chat session.');
} finally { await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
