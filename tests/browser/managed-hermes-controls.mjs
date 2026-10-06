import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = process.env.HERMES_CONTROLS_SOURCE_ROOT ? path.resolve(process.env.HERMES_CONTROLS_SOURCE_ROOT) : root;
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const dir = await mkdtemp(path.join(tmpdir(), 'managed-hermes-browser-'));
const entry = path.join(dir, 'entry.tsx');
await writeFile(entry, `import React from 'react'; import { createRoot } from '${root}/node_modules/react-dom/client'; import { HermesNativeControls } from '${sourceRoot}/src/components/chat/hermes-native-controls'; createRoot(document.getElementById('root')!).render(<HermesNativeControls conversationId="fixture-conversation"/>);`);
const bundle = await build({ entryPoints: [entry], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.join(root, 'node_modules')], alias: { '@': path.join(sourceRoot, 'src') } });
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
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  res.setHeader('Content-Type', 'application/json');
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
const browser = await chromium.launch({ headless: true });
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
} finally { releaseSecret(); await browser.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
