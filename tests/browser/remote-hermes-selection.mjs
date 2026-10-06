// Synthetic localhost-only regression for native Hermes selection and pagination.
// Run: node tests/browser/remote-hermes-selection.mjs [artifact-directory]
// PLAYWRIGHT_BROWSERS_PATH selects an isolated browser cache. Reports and failure
// screenshots default to a temporary directory; an explicit directory must be
// outside the repository. HERMES_BROWSER_NODE_MODULES can select separately
// installed dependencies without modifying the checkout's node_modules.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : await mkdtemp(path.join(tmpdir(), 'collective-hermes-selection-'));
const artifactRelative = path.relative(root, artifactDir);
if (!artifactRelative || (artifactRelative !== '..' && !artifactRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(artifactRelative)))
  throw new Error('Browser artifacts must be written outside the repository.');
await mkdir(artifactDir, { recursive: true });
const moduleRoot = process.env.HERMES_BROWSER_NODE_MODULES
  ? path.resolve(process.env.HERMES_BROWSER_NODE_MODULES)
  : path.join(root, 'node_modules');
const component = path.join(root, 'src/components/hermes/native-workspace.tsx');
const require = createRequire(path.join(moduleRoot, 'fixture-require.js'));
const { build } = require('esbuild');
const { chromium, expect } = require('@playwright/test');
const saved = [
  { id: 'a', storedId: 'stored-a', title: 'Session A', profile: 'default', status: 'idle' },
  { id: 'b', storedId: 'stored-b', title: 'Session B', profile: 'default', status: 'idle' },
  { id: 'c', storedId: 'stored-c', title: 'Session C', profile: 'alternate', status: 'idle' },
];
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import { NativeWorkspace } from ${JSON.stringify(component)}; createRoot(document.getElementById('root')).render(<NativeWorkspace connectionId="fixture" profiles={[{name:'default'},{name:'alternate'}]} saved={${JSON.stringify(saved)}} allowed={true} initialSession="a" initialError=""/>);`,
    resolveDir: root, loader: 'tsx', sourcefile: 'hermes-selection-entry.tsx',
  },
  write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  nodePaths: [moduleRoot], alias: { '@': path.join(root, 'src') },
  plugins: [{ name: 'fixture-link', setup(builder) {
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `import React from 'react';export default function Link({children,...props}){return <a {...props}>{children}</a>}`, loader: 'jsx', resolveDir: root }));
  } }, { name: 'fixture-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.fixtureDependencies || args.path.startsWith('@/') || args.path.startsWith('#') || args.resolveDir.startsWith(`${moduleRoot}${path.sep}`)) return;
      return builder.resolve(args.path, { kind: args.kind, resolveDir: path.dirname(moduleRoot), pluginData: { fixtureDependencies: true } });
    });
  } }],
});
const snapshot = id => ({
  id, title: `Session ${id.toUpperCase()}`, profile: id === 'c' ? 'alternate' : 'default',
  running: false, uncertain: false, connection: 'connected',
  messages: [{ id: `${id}-current`, role: 'assistant', text: `Current ${id.toUpperCase()} message` }],
  partial: '', tools: [], prompts: [], model: 'Synthetic model', provider: 'Fixture', usage: {}, queued: '', admissionAllowed: true,
});
const received = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].contents); return; }
  if (!url.pathname.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') {
    const input = Object.fromEntries(url.searchParams); received.push({ method: 'GET', ...input });
    if (input.operation === 'browse') {
      const offset = Number(input.offset || 0);
      if (input.profile === 'alternate') res.end(JSON.stringify({ sessions: [{ id: 'alternate-unlinked', title: 'Alternate unlinked chat' }], linked: saved, nextOffset: 100, hasMore: false }));
      else {
        const sessions = Array.from({ length: Math.min(100, Math.max(0, 201 - offset)) }, (_, i) => ({ id: `chat-${offset + i}`, title: `Native chat ${offset + i}` }));
        if (!sessions.some(s => s.id === 'chat-200')) sessions.push({ id: 'chat-200', title: 'Older pinned chat' });
        res.end(JSON.stringify({ sessions, linked: saved, nextOffset: offset + 100, hasMore: offset + 100 < 201 }));
      }
    } else if (input.operation === 'history') res.end(JSON.stringify({ messages: [{ id: `old-${input.sessionId}`, role: 'user', text: `Delayed ${input.sessionId.toUpperCase()} history` }], nextOffset: 200, hasMore: false }));
    else res.end(JSON.stringify(snapshot(input.sessionId)));
    return;
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let input;
  if ((req.headers['content-type'] || '').startsWith('multipart/')) {
    const data = await new Response(body, { headers: { 'Content-Type': req.headers['content-type'] } }).formData();
    input = JSON.parse(data.get('request')); input.files = data.getAll('files').map(f => f.name);
  } else input = JSON.parse(body.toString());
  received.push({ method: 'POST', ...input });
  res.end(JSON.stringify(input.operation === 'open' ? snapshot(`opened-${input.storedId}`) : { accepted: true }));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const results = [];
const init = ({ rules }) => {
  const nativeFetch = window.fetch.bind(window);
  const state = window.__fixture = { rules, pending: {}, completed: [], requests: [] };
  window.fetch = async (input, options) => {
    const url = new URL(String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, options);
    const params = Object.fromEntries(url.searchParams);
    state.requests.push({ method: options?.method || 'GET', ...params });
    const index = state.rules.findIndex(rule => Object.entries(rule.match).every(([key, value]) => params[key] === value));
    const rule = index < 0 ? null : state.rules.splice(index, 1)[0];
    if (!rule) return nativeFetch(input, options);
    const response = await nativeFetch(input, options);
    const bytes = await response.arrayBuffer();
    // Delay delivery of a completely buffered localhost response. This verifies the
    // selection generation fence even when cancelling transport is already too late.
    await new Promise(resolve => { state.pending[rule.name] = resolve; });
    state.completed.push(rule.name);
    return rule.error
      ? new Response(JSON.stringify({ error: rule.error }), { status: 502, headers: { 'Content-Type': 'application/json' } })
      : new Response(bytes, { status: response.status, headers: response.headers });
  };
};
const flush = async page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const gate = (name, match, error) => ({ name, match, ...(error ? { error } : {}) });
async function ready(rules = []) {
  const context = await browser.newContext();
  await context.addInitScript(init, { rules });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/hermes/fixture?session=a`);
  return { context, page, errors };
}
async function pending(page, name) { await expect.poll(() => page.evaluate(n => !!window.__fixture.pending[n], name)).toBe(true); }
async function release(page, name) {
  await page.evaluate(n => { window.__fixture.pending[n](); delete window.__fixture.pending[n]; }, name);
  await expect.poll(() => page.evaluate(n => window.__fixture.completed.includes(n), name)).toBe(true);
  await flush(page);
}
async function chooseProfile(page, name) {
  await page.getByRole('combobox', { name: 'Hermes profile' }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function run(name, rules, check) {
  const start = received.length; let session;
  try {
    session = await ready(rules); await check(session.page);
    expect(session.errors).toEqual([]);
    results.push({ name, passed: true, requests: received.slice(start) });
  } catch (error) {
    const screenshot = path.join(artifactDir, `selection-${name}.png`);
    if (session) await session.page.screenshot({ path: screenshot, fullPage: true });
    results.push({ name, passed: false, error: String(error.message).slice(0, 1600), browserErrors: session?.errors || [], screenshot, requests: received.slice(start) });
  } finally { await session?.context.close(); }
}
try {
  await run('composer-chat-reset', [], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message Hermes' }).fill('Draft belonging to A');
    await page.getByLabel('Attach files to Hermes').setInputFiles({ name: 'a-private-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic A attachment') });
    await page.getByRole('button', { name: 'Session B', exact: true }).click();
    await expect(page.getByText('Current B message')).toBeVisible();
    expect(await page.getByRole('textbox', { name: 'Message Hermes' }).inputValue()).toBe('');
    expect(await page.getByText('a-private-fixture.txt', { exact: true }).count()).toBe(0);
    expect(await page.getByLabel('Attach files to Hermes').evaluate(el => el.files.length)).toBe(0);
  });
  await run('composer-profile-reset', [], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message Hermes' }).fill('Draft belonging to default');
    await page.getByLabel('Attach files to Hermes').setInputFiles({ name: 'default-private-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic default attachment') });
    await chooseProfile(page, 'alternate');
    await page.getByRole('button', { name: 'Session C', exact: true }).click();
    await expect(page.getByText('Current C message')).toBeVisible();
    expect(await page.getByRole('textbox', { name: 'Message Hermes' }).inputValue()).toBe('');
    expect(await page.getByText('default-private-fixture.txt', { exact: true }).count()).toBe(0);
  });
  await run('attachment-chat-reset', [], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByLabel('Attach files to Hermes').setInputFiles({ name: 'a-private-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic A attachment') });
    await page.getByRole('button', { name: 'Session B', exact: true }).click();
    await expect(page.getByText('Current B message')).toBeVisible();
    expect(await page.getByText('a-private-fixture.txt', { exact: true }).count()).toBe(0);
    expect(await page.getByLabel('Attach files to Hermes').evaluate(el => el.files.length)).toBe(0);
    await page.getByRole('textbox', { name: 'Message Hermes' }).fill('B message without A attachment');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => received.some(r => r.method === 'POST' && r.operation === 'submit' && r.sessionId === 'b' && r.text === 'B message without A attachment' && !r.files?.length)).toBe(true);
  });
  await run('delayed-old-profile-browse', [gate('browse-a', { operation: 'browse', profile: 'default', offset: '0' })], async page => {
    await pending(page, 'browse-a');
    await chooseProfile(page, 'alternate');
    await expect(page.getByRole('button', { name: 'Alternate unlinked chat', exact: true })).toBeVisible();
    await release(page, 'browse-a');
    expect(await page.getByRole('button', { name: 'Native chat 0', exact: true }).count()).toBe(0);
    await expect(page.getByRole('button', { name: 'Alternate unlinked chat', exact: true })).toBeVisible();
  });
  await run('delayed-old-chat-snapshot', [gate('snapshot-a', { operation: 'snapshot', sessionId: 'a' })], async page => {
    await pending(page, 'snapshot-a');
    await page.getByRole('button', { name: 'Session B', exact: true }).click();
    await expect(page.getByText('Current B message')).toBeVisible();
    await release(page, 'snapshot-a');
    expect(await page.getByText('Current A message').count()).toBe(0);
    await expect(page.getByText('Current B message')).toBeVisible();
  });
  await run('delayed-history-other-chat', [gate('history-a', { operation: 'history', sessionId: 'a' })], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByRole('button', { name: 'Load conversation history', exact: true }).click(); await pending(page, 'history-a');
    await page.getByRole('button', { name: 'Session B', exact: true }).click(); await expect(page.getByText('Current B message')).toBeVisible();
    await release(page, 'history-a');
    expect(await page.getByText('Delayed A history').count()).toBe(0);
  });
  await run('delayed-history-returned-chat', [gate('history-a', { operation: 'history', sessionId: 'a' })], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByRole('button', { name: 'Load conversation history', exact: true }).click(); await pending(page, 'history-a');
    await page.getByRole('button', { name: 'Session B', exact: true }).click(); await expect(page.getByText('Current B message')).toBeVisible();
    await page.getByRole('button', { name: 'Session A', exact: true }).click(); await expect(page.getByText('Current A message')).toBeVisible();
    await release(page, 'history-a');
    expect(await page.getByText('Delayed A history').count()).toBe(0);
    await expect(page.getByRole('button', { name: 'Load conversation history', exact: true })).toBeEnabled();
  });
  await run('delayed-history-error-other-chat', [gate('history-error-a', { operation: 'history', sessionId: 'a' }, 'Old A history request failed')], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByRole('button', { name: 'Load conversation history', exact: true }).click(); await pending(page, 'history-error-a');
    await page.getByRole('button', { name: 'Session B', exact: true }).click(); await expect(page.getByText('Current B message')).toBeVisible();
    await release(page, 'history-error-a');
    expect(await page.getByText('Old A history request failed').count()).toBe(0);
  });
  await run('history-busy-reset', [gate('history-a', { operation: 'history', sessionId: 'a' })], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByRole('button', { name: 'Load conversation history', exact: true }).click(); await pending(page, 'history-a');
    await page.getByRole('button', { name: 'Session B', exact: true }).click(); await expect(page.getByText('Current B message')).toBeVisible();
    // A's in-flight history must not block B's independent history.
    expect(await page.getByRole('button', { name: 'Load conversation history', exact: true }).count()).toBe(1);
    await expect(page.getByRole('button', { name: 'Load conversation history', exact: true })).toBeEnabled();
    await release(page, 'history-a');
  });
  await run('old-history-finally-keeps-new-request-busy', [gate('history-a', { operation: 'history', sessionId: 'a' }), gate('history-b', { operation: 'history', sessionId: 'b' })], async page => {
    await expect(page.getByText('Current A message')).toBeVisible();
    await page.getByRole('button', { name: 'Load conversation history', exact: true }).click(); await pending(page, 'history-a');
    await page.getByRole('button', { name: 'Session B', exact: true }).click(); await expect(page.getByText('Current B message')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load conversation history', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Load conversation history', exact: true }).click(); await pending(page, 'history-b');
    await release(page, 'history-a');
    await expect(page.getByRole('button', { name: 'Loading history…', exact: true })).toBeDisabled();
    expect(await page.getByText('Delayed A history').count()).toBe(0);
    await release(page, 'history-b');
    await expect(page.getByText('Delayed B history')).toBeVisible();
  });
  await run('pinned-page-and-open-offsets', [], async page => {
    await expect(page.getByRole('button', { name: 'Older pinned chat', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Load more chats', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Native chat 150', exact: true })).toBeVisible();
    expect(await page.getByRole('button', { name: 'Older pinned chat', exact: true }).count()).toBe(1);
    const requests = await page.evaluate(() => window.__fixture.requests.filter(r => r.operation === 'browse'));
    expect(requests.map(r => r.offset)).toEqual(['0', '100']);
    await page.getByRole('button', { name: 'Older pinned chat', exact: true }).click();
    await expect.poll(() => received.some(r => r.method === 'POST' && r.operation === 'open' && r.storedId === 'chat-200' && r.offset === 0)).toBe(true);
    await page.getByRole('button', { name: 'Load more chats', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Native chat 150', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Native chat 150', exact: true }).click();
    await expect.poll(() => received.some(r => r.method === 'POST' && r.operation === 'open' && r.storedId === 'chat-150' && r.offset === 100)).toBe(true);
  });
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
const report = {
  source: component, nodeModules: moduleRoot, sourceSha256: createHash('sha256').update(await readFile(component)).digest('hex'),
  transport: 'synthetic localhost only; completed-response delivery gates; isolated headless browser',
  passed: results.filter(r => r.passed).length, total: results.length, results,
};
const reportFile = path.join(artifactDir, 'remote-hermes-selection-results.json');
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: reportFile, passed: report.passed, total: report.total, results: results.map(({ name, passed }) => ({ name, passed })) }, null, 2));
process.exitCode = results.every(r => r.passed) ? 0 : 1;
