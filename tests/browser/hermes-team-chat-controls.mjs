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
const dir = await mkdtemp(path.join(tmpdir(), 'hermes-team-chat-ui-'));
const entry = path.join(dir, 'entry.tsx');
const navigation = path.join(dir, 'navigation.ts');
await writeFile(navigation, `export const useRouter = () => ({ push: path => { window.fixtureNavigation = path; } });`);
await writeFile(entry, `import React, { useState } from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client'; import { HermesTeamChatControls } from '${root}/src/components/chat/hermes-team-chat-controls'; function App() { const [context, setContext] = useState({ botId:'team-one', conversationId:'new-context', started:false, busy:false }); window.fixtureContext = setContext; return <HermesTeamChatControls {...context}/>; } createRoot(document.getElementById('root')).render(<App/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src'), 'next/navigation': navigation } });
const requests = [];
const view = { enabled: true, mode: 'member', canMaintain: true, state: 'ready', installedRevision: 2, publishedRevision: 2, conflictCount: 0 };
let denyOpen = false; let denyStatus = false; let holdStatus = false; let releaseStatus;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!req.url.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    requests.push({ method: 'GET', pathname: url.pathname, conversationId: url.searchParams.get('conversationId') });
    if (holdStatus) await new Promise(resolve => { releaseStatus = resolve; });
    if (denyStatus) { res.statusCode = 403; res.end(JSON.stringify({ error: 'Your Team Bot access was removed.' })); }
    else res.end(JSON.stringify(view));
    return;
  }
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const body = JSON.parse(Buffer.concat(bytes).toString()); requests.push({ method: req.method, pathname: url.pathname, body });
  if (denyOpen) { res.statusCode = 403; res.end(JSON.stringify({ error: 'Only current maintainers can open Admin mode.' })); }
  else res.end(JSON.stringify({ conversationId: 'server-selected-conversation', state: 'connection_needed' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const mode = page.getByRole('switch', { name: 'Admin mode' }); await expect(mode).toBeVisible();
  expect(requests[0]).toEqual({ method: 'GET', pathname: '/api/bots/team-one/team', conversationId: null });
  denyOpen = true; await mode.click(); await expect(page.getByRole('alert')).toHaveText('Only current maintainers can open Admin mode.');
  await expect(mode).not.toBeChecked(); expect(await page.evaluate(() => window.fixtureNavigation)).toBeUndefined();
  denyOpen = false; await mode.click();
  await expect.poll(() => page.evaluate(() => window.fixtureNavigation)).toBe('/c/server-selected-conversation');
  expect(requests.filter(request => request.method === 'POST')).toEqual([
    { method: 'POST', pathname: '/api/bots/team-one/team/open', body: { mode: 'admin' } },
    { method: 'POST', pathname: '/api/bots/team-one/team/open', body: { mode: 'admin' } },
  ]);
  holdStatus = true;
  await page.evaluate(() => window.fixtureContext({ botId: 'team-two', conversationId: 'saved-context', started: true, busy: false }));
  await expect(page.getByRole('region', { name: 'Hermes Team Bot controls' })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Preparing Team Bot controls…');
  await expect.poll(() => requests.at(-1)?.pathname).toBe('/api/bots/team-two/team');
  expect(requests.at(-1).conversationId).toBe('saved-context');
  holdStatus = false; releaseStatus(); await expect(mode).toBeVisible();
  denyStatus = true; await expect(page.getByRole('alert')).toHaveText('Your Team Bot access was removed.', { timeout: 7000 });
  await expect(page.getByRole('region', { name: 'Hermes Team Bot controls' })).toHaveCount(0);
  denyStatus = false; await page.getByRole('button', { name: 'Try again' }).click(); await expect(mode).toBeVisible();
  Object.assign(view,{state:'connection_needed',modelAccessAvailable:false,modelAccessReason:'Team models are unavailable in this build. Ask an admin to configure a supported connection.'});
  await page.evaluate(() => window.fixtureContext({botId:'team-two',conversationId:'model-unavailable-context',started:true,busy:false}));
  await expect(page.getByText('Team models are unavailable in this build. Ask an admin to configure a supported connection.',{exact:true})).toBeVisible();
  await expect(page.getByText('Model access unavailable',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Settings',exact:true})).toHaveCount(0);
  view.modelAccessAvailable=true;
  await page.evaluate(() => window.fixtureContext({botId:'team-two',conversationId:'model-reconnect-context',started:true,busy:false}));
  await expect(page.getByRole('link',{name:'Settings',exact:true})).toBeVisible();await expect(page.getByText('Model connection needed',{exact:true})).toBeVisible();
  await expect(page.getByText('Team models are unavailable in this build. Ask an admin to configure a supported connection.',{exact:true})).toHaveCount(0);
  await page.evaluate(() => window.fixtureContext({ botId: 'team-two', conversationId: 'saved-context', started: true, busy: true })); await expect(mode).toBeDisabled();
  expect(errors).toEqual([]);
  console.log('PASS: server-only mode open identity, rejected navigation, current conversation query, stale-context clearing, revoked status and retry, active-work disablement, server-confirmed unavailable model reason versus verified reconnect guidance; synthetic HTTP only.');
} finally { if (releaseStatus) releaseStatus(); await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
