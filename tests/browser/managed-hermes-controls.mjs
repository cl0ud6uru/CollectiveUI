import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = process.env.HERMES_CONTROLS_SOURCE_ROOT ? path.resolve(process.env.HERMES_CONTROLS_SOURCE_ROOT) : root;
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const postcss = require('postcss'), tailwind = require('@tailwindcss/postcss');
const dir = await mkdtemp(path.join(tmpdir(), 'managed-hermes-browser-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client'; import { HermesNativeControls } from '${sourceRoot}/src/components/chat/hermes-native-controls'; import { HermesProfileSettings } from '${sourceRoot}/src/components/settings/hermes-profile-settings'; createRoot(document.getElementById('root')!).render(location.pathname === '/profile' ? <HermesProfileSettings botId="fixture-bot"/> : <HermesNativeControls conversationId="fixture-conversation"/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(sourceRoot, 'src') }, plugins: [{ name: 'existing-action-boundary', setup(b) {
  b.onResolve({ filter: /^(next\/link|next\/navigation|@\/app\/\(chat\)\/actions)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'tsx', resolveDir: root, contents: args.path === 'next/link' ? `import React from '${root}/node_modules/react'; export default function Link({children,...props}){return React.createElement('a',props,children);}` : args.path === 'next/navigation' ? `export const useRouter=()=>({push:path=>{window.fixtureNavigation=path;}});` : `export async function createSideChat(botId,conversationId){const res=await fetch('/api/fixture-chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({botId,conversationId})}); if(!res.ok)throw new Error('Fixture chat unavailable');return res.json();}` }));
} }] });
const css = await postcss([tailwind({ base: sourceRoot })]).process(await readFile(path.join(sourceRoot, 'src/app/globals.css'), 'utf8'), { from: path.join(sourceRoot, 'src/app/globals.css') });
let profile = { revision: 'a'.repeat(64), provider: null, model: 'seed-model', reasoningEffort: '', maxTurns: null, advancedSupported: true,
  editableProviders: { 'openai-api': true, anthropic: true, openrouter: true, 'openai-codex': true },
  credentials: { 'openai-api': false, anthropic: false, openrouter: false, 'openai-codex': false }, lastTest: null };
let profileNetwork = 'internet', profileUnavailable = false;
const profileRequests = [], chats = [];
const requestIds = ['a', 'b', 'c', 'd', 'e'].map(letter => letter.repeat(32));
const prompt = (id, method, title, questions = [], single = false) => ({ id, method, title, command: '', questions, single });
let prompts = [prompt(requestIds[0], 'clarify', 'Batch fixture questions', [{ id: 'first', question: 'First fixture answer', choices: [] }, { id: 'second', question: 'Second fixture answer', choices: [] }])];
let queued = ''; let includeView = true; let inspectAllowed = true; let rejectNext = false;
const received = []; let releaseSecret; let secretArrived;
const secretPosted = new Promise(resolve => { secretArrived = resolve; });
const secretResponse = new Promise(resolve => { releaseSecret = resolve; });
const view = () => ({ running: true, status: 'running', model: 'Fixture model', provider: 'Fixture', usage: { context_percent: 12 }, prompts, queued, features: ['clarify', 'secret', 'steer', 'queue'] });
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css.css); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script></html>'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/api/bots/fixture-bot/native/codex') { res.end(JSON.stringify({ state: 'disconnected' })); return; }
  if (url.pathname === '/api/bots/fixture-bot/native/settings') {
    if (req.method === 'GET') {
      if (profileUnavailable) { res.statusCode = 503; res.end(JSON.stringify({ error: 'Synthetic profile temporarily unavailable.' })); }
      else res.end(JSON.stringify({ settings: profile, runtime: { phase: 'ready', network: profileNetwork } }));
      return;
    }
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    const input = JSON.parse(Buffer.concat(bytes).toString()); profileRequests.push(input);
    if (input.operation === 'save') {
      expect(input.settings.revision).toBe(profile.revision);
      const next = input.settings;
      profile = { ...profile, provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort, maxTurns: next.maxTurns,
        revision: (profile.revision[0] === 'a' ? 'b' : 'c').repeat(64), lastTest: null,
        credentials: { ...profile.credentials, [next.provider]: next.credential.action === 'replace' } };
      res.end(JSON.stringify(profile)); return;
    }
    expect(input.operation).toBe('test'); expect(input.test.revision).toBe(profile.revision); expect(input.test.consent).toBe(true);
    profile.lastTest = { revision: profile.revision, code: profileRequests.filter(r => r.operation === 'test').length === 1 ? 'authentication_failed' : 'verified', checkedAt: '2026-10-07T00:00:00Z' };
    res.end(JSON.stringify(profile.lastTest)); return;
  }
  if (url.pathname === '/api/fixture-chat') {
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    chats.push(JSON.parse(Buffer.concat(bytes).toString())); res.end(JSON.stringify({ id: 'fixture-new-conversation' })); return;
  }
  if (req.method === 'GET') { if (!inspectAllowed) { res.statusCode = 403; res.end(JSON.stringify({ error: 'Synthetic owner rejection.' })); } else res.end(JSON.stringify({ view: includeView ? view() : null })); return; }
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const input = JSON.parse(Buffer.concat(bytes).toString()); received.push(input);
  if (rejectNext) { rejectNext = false; res.statusCode = 403; res.end(JSON.stringify({ error: 'Synthetic owner rejection.' })); return; }
  if (input.operation === 'answer') {
    if (input.requestId === requestIds[0]) prompts = [prompt(requestIds[1], 'clarify', 'Single fixture question', [], true)];
    else if (input.requestId === requestIds[1]) prompts = [prompt(requestIds[2], 'clarify', 'Batch skip fixture', [{ id: 'skipped', question: 'Optional batch answer', choices: [] }])];
    else if (input.requestId === requestIds[2]) prompts = [prompt(requestIds[3], 'clarify', 'Single skip fixture', [], true)];
    else if (input.requestId === requestIds[3]) prompts = [prompt(requestIds[4], 'secret', 'Protected fixture password')];
    else if (input.requestId === requestIds[4]) { secretArrived(); await secretResponse; prompts = []; }
  }
  if (input.operation === 'queue') queued = input.text;
  res.end(JSON.stringify({ accepted: true }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/chat/fixture`);
  await expect(page.getByRole('region', { name: 'Native Hermes controls' })).toBeVisible();
  await page.getByLabel('First fixture answer').fill('First reply'); await page.getByLabel('Second fixture answer').fill('Second reply');
  await page.getByRole('button', { name: 'Answer Hermes' }).click();
  await page.getByLabel('Single fixture question', { exact: true }).fill('Single reply'); await page.getByRole('button', { name: 'Answer Hermes' }).click();
  await expect(page.getByText('Batch skip fixture', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.getByText('Single skip fixture', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Skip', exact: true }).click();
  const protectedField = page.getByLabel('Protected value for native Hermes');
  await protectedField.fill('synthetic-protected-password'); await page.getByRole('button', { name: 'Answer Hermes' }).click(); await secretPosted;
  // Keep the network response pending: clearing must happen before acknowledgement, including failures.
  await expect(protectedField).toHaveValue(''); await expect(protectedField).toBeDisabled();
  expect(await page.locator('body').textContent()).not.toContain('synthetic-protected-password'); releaseSecret();
  await expect(page.getByText('Protected fixture password', { exact: true })).toHaveCount(0);
  const composer = page.getByLabel('Correct or queue native Hermes work');
  if (!await composer.isVisible()) await page.locator('summary').click();
  await composer.fill('Fixture correction'); await page.getByRole('button', { name: 'Steer current turn' }).click(); await expect(composer).toHaveValue('');
  await composer.fill('Fixture next message'); await page.getByRole('button', { name: 'Queue in Hermes' }).click();
  await expect(page.getByText('Queued in Hermes: Fixture next message')).toBeVisible(); await expect(page.getByRole('button', { name: 'Queue in Hermes' })).toBeDisabled();
  rejectNext = true; await composer.fill('Rejected correction'); await page.getByRole('button', { name: 'Steer current turn' }).click();
  await expect(page.getByRole('alert')).toHaveText('Synthetic owner rejection.'); await expect(composer).toHaveValue('Rejected correction');
  inspectAllowed = false; await expect(page.getByRole('region', { name: 'Native Hermes controls' })).toHaveCount(0);
  inspectAllowed = true; includeView = false; await page.reload(); await expect(page.getByRole('region', { name: 'Native Hermes controls' })).toHaveCount(0);
  expect(received.map(input => input.operation)).toEqual(['answer', 'answer', 'answer', 'answer', 'answer', 'steer', 'queue', 'steer']);
  expect(received[0].answer).toEqual({ answers: { first: 'First reply', second: 'Second reply' } });
  expect(received[1].answer).toEqual({ answer: 'Single reply' }); expect(received[2].answer).toEqual({ answers: {} }); expect(received[3].answer).toEqual({ answer: '' });
  expect(received[4].answer).toEqual({ value: 'synthetic-protected-password' });
  expect(received[5]).toMatchObject({ operation: 'steer', text: 'Fixture correction' }); expect(received[6]).toMatchObject({ operation: 'queue', text: 'Fixture next message' });
  expect(received[5].requestId).toMatch(/^[a-f0-9-]{36}$/); expect(received[6].requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(errors).toEqual([]);
  console.log('PASS: managed native batch/single clarification and skips, password clearing before acknowledgement, steer/queue, rejected control, ownership rejection and hidden missing view; no browser errors.');

  await page.goto(`http://127.0.0.1:${server.address().port}/profile`);
  const startChat = page.getByRole('button', { name: 'Start chatting', exact: true });
  const testConnection = page.getByRole('button', { name: 'Test saved connection', exact: true });
  await expect(startChat).toBeDisabled(); await expect(testConnection).toBeDisabled();
  await page.getByLabel('Model provider', { exact: true }).click(); await page.getByRole('option', { name: 'OpenAI API', exact: true }).click();
  await expect(page.getByLabel('New API key', { exact: true })).toBeVisible();
  await page.getByLabel('Model ID', { exact: true }).fill('fixture-model'); await page.getByLabel('New API key', { exact: true }).fill('synthetic-profile-key');
  await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByText('API key saved', { exact: true })).toBeVisible();
  expect(profileRequests.map(r => r.operation)).toEqual(['save']); await expect(startChat).toBeDisabled();
  await expect(page.getByLabel('New API key', { exact: true })).toHaveCount(0);
  await page.getByLabel('I understand this test may incur inference charges.').check(); await testConnection.click();
  await expect(page.getByRole('alert').filter({ hasText: 'provider rejected the API key' })).toBeVisible(); await expect(startChat).toBeDisabled();
  await page.getByLabel('API key', { exact: true }).click(); await page.getByRole('option', { name: 'Replace API key', exact: true }).click();
  await page.getByLabel('New API key', { exact: true }).fill('synthetic-replacement-key'); await page.getByRole('button', { name: 'Save profile settings', exact: true }).click();
  await expect(page.getByText('API key saved', { exact: true })).toBeVisible();
  await page.getByLabel('I understand this test may incur inference charges.').check(); await testConnection.click(); await expect(startChat).toBeEnabled();
  expect(profileRequests.map(r => r.operation)).toEqual(['save', 'test', 'save', 'test']);
  expect(profileRequests[1].test.requestId).not.toBe(profileRequests[3].test.requestId);
  expect(JSON.stringify(profile)).not.toContain('synthetic-replacement-key');
  for (const width of [320, 390, 768, 1280]) { await page.setViewportSize({ width, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(process.env.HERMES_CONTROLS_SCREENSHOT_DIR || tmpdir(), 'hermes-provider-setup-mobile.png'), fullPage: true });
  await startChat.click(); await expect.poll(() => page.evaluate(() => window.fixtureNavigation)).toBe('/c/fixture-new-conversation');
  expect(chats).toHaveLength(1); expect(chats[0].botId).toBe('fixture-bot'); expect(chats[0].conversationId).toMatch(/^[A-Za-z0-9]{16}$/);
  profile.revision = 'd'.repeat(64); await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click();
  await expect(startChat).toBeDisabled(); await expect(page.getByText('Connection verified for this saved model and API key.', { exact: false })).toHaveCount(0);
  profileUnavailable = true; await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'temporarily unavailable' })).toBeVisible(); await expect(startChat).toBeDisabled();
  profileUnavailable = false; await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  profileNetwork = 'none'; profile.lastTest = { code: 'verified', revision: profile.revision, checkedAt: '2026-10-07T00:00:00Z' };
  await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click(); await expect(startChat).toBeDisabled(); await expect(testConnection).toBeDisabled();
  profileNetwork = 'internet'; profile.provider = 'openai-codex'; profile.credentials['openai-codex'] = true; profile.lastTest = null;
  await page.getByRole('button', { name: 'Reload saved settings', exact: true }).click(); await expect(startChat).toBeDisabled();
  await expect(page.getByText('The newer personal ChatGPT plan login needs a supported device return path and is not available in this setup.', { exact: false })).toBeVisible();
  expect(profileRequests).toHaveLength(4); expect(chats).toHaveLength(1); expect(errors).toEqual([]);
  console.log('PASS: native API-key connect, explicit failed test and key replacement/retry, exact-revision verified fresh chat, stale/offline/outage gates, unsupported personal plan explanation and mobile layouts; no automatic inference.');
} finally { releaseSecret(); await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
