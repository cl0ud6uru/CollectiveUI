// Production Chat, Composer, native-search verification, and AI SDK with loopback-only synthetic I/O.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.COLLECTIVE_UI_SOURCE_ROOT ?? fileURLToPath(new URL('../../', import.meta.url));
const dir = await mkdtemp(path.join(tmpdir(), 'composer-focus-'));
const bundle = await build({
  absWorkingDir: root,
  stdin: { contents: `
import React from 'react'; import { createRoot } from 'react-dom/client'; import { Tooltip } from 'radix-ui';
import { ShellProvider } from '@/components/chat/shell-context'; import { Chat } from '@/components/chat/chat'; import { Composer } from '@/components/chat/composer';
const query=new URLSearchParams(location.search);
const target={kind:'app',id:'synthetic-model',name:'Synthetic model',icon:null};
const initialRows=query.has('saved')?[
 {id:'question',parentId:null,createdAt:1,feedback:null,message:{id:'question',role:'user',parts:[{type:'text',text:'Earlier question'}]}},
 {id:'answer',parentId:'question',createdAt:2,feedback:null,message:{id:'answer',role:'assistant',parts:[{type:'text',text:'Earlier answer'}]}}
]:[];
window.commands=[];
function LocalComposer(){return <Composer busy={false} commands={[]} onStop={()=>{}} onSend={(text,files)=>new Promise(resolve=>{window.commands.push({text,files});window.finishCommand=(accepted=false)=>resolve(accepted);})}/>;}
createRoot(document.getElementById('root')).render(<React.StrictMode><Tooltip.Provider><button id="elsewhere">Other control</button><div id="blank">Nonfocusable area</div>{query.has('command')?<LocalComposer/>:<ShellProvider user={{id:'fixture',name:'Fixture',isAdmin:false,canCreateBots:false}} branding={{appName:'CollectiveUI',welcomeText:'Synthetic chat',logoEmoji:''}} bots={[]} apps={[target]} conversations={[]} folders={[]} inboxUnread={0}><Chat embedded conversationId="synthetic-focus-chat" isNew={!query.has('saved')} target={target} initialRows={initialRows} initialLeafId={initialRows.at(-1)?.id??null}/></ShellProvider>}</Tooltip.Provider></React.StrictMode>);
`, resolveDir: root, loader: 'tsx' },
  bundle: true, outfile: path.join(dir, 'app.js'), write: false, jsx: 'automatic',
  define: { 'process.env': '{}', 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'synthetic-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(next\/navigation|next\/link)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onResolve({ filter: /^@\/app\/.*actions$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, async args => {
      if (args.path === 'next/link') return { contents: 'import React from "react";export default React.forwardRef(({href,prefetch,children,...props},ref)=><a href={href} ref={ref} {...props}>{children}</a>);', loader: 'jsx', resolveDir: root };
      if (args.path === 'next/navigation') return { contents: 'const router={refresh(){},push(){}};export const useRouter=()=>router;export const usePathname=()=>"/";export const useSearchParams=()=>new URLSearchParams(location.search);', loader: 'js' };
      const source = await readFile(path.join(root, 'src', args.path.slice(2) + '.ts'), 'utf8');
      const names = [...source.matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]);
      return { contents: names.map(name => `export const ${name}=async()=>${name === 'refreshBotStatuses' ? '({})' : '{throw Error("No server actions in synthetic focus fixture")}'};`).join('\n'), loader: 'js' };
    });
  } }],
});
const streams = new Map();
const writePart = (response, part) => response.write('data: ' + JSON.stringify(part) + '\n\n');
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/fixture/stream/')) {
    for await (const chunk of req) { void chunk; }
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
    writePart(res, { type: 'start', messageId: 'streamed-reply' });
    writePart(res, { type: 'text-start', id: 'text' });
    writePart(res, { type: 'text-delta', id: 'text', delta: 'Streaming response' });
    streams.set(req.url, res);
    res.on('close', () => streams.delete(req.url));
    return;
  }
  const name = req.url === '/app.js' ? 'app.js' : req.url === '/app.css' ? 'app.css' : null;
  res.setHeader('Content-Type', name?.endsWith('.js') ? 'text/javascript' : name ? 'text/css' : 'text/html');
  res.end(name ? bundle.outputFiles.find(file => file.path.endsWith(name))?.contents : '<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>textarea{display:block;width:500px}button{margin:4px}svg{width:20px;height:20px}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
const failures = [];
let passed = 0;
let sequence = 0;
async function check(name, run) {
  const streamPath = `/fixture/stream/${++sequence}`;
  const page = await browser.newPage();
  const errors = [], requests = [], searchRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  // Explicitly block every non-fixture request. Never contact providers or production.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/chat' && route.request().method() === 'POST') { requests.push(route); return; }
    if (url.pathname === '/api/chat/native-search') { searchRequests.push(route); if (searchRequests.length > 2 && holdSearch) return; return route.fulfill({ json: { mode: 'off', reason: 'Synthetic', maxCalls: 2 } }); }
    if (url.pathname === '/api/files' && route.request().method() === 'POST') { uploads.push(route); return; }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: url.pathname.endsWith('/approvals') ? { requests: [] } : url.pathname === '/api/workspace/status' ? { available: false } : [] });
    return route.continue();
  });
  let holdSearch = false;
  const uploads = [];
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const other = page.locator('#elsewhere');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const load = async (query = '') => { await page.goto(origin + '/' + query); await expect(input).toBeEnabled(); };
  const begin = async (method = 'enter', text = 'Synthetic message') => {
    await input.fill(text);
    // Track DOM identity, focus/blur, and disabled transitions as reproduction evidence.
    await input.evaluate(element => {
      window.originalInput = element; window.focusTrace = [];
      for (const event of ['focusin', 'focusout']) document.addEventListener(event, e => window.focusTrace.push({ event, target: e.target.getAttribute?.('aria-label') ?? e.target.id, disabled: element.disabled, connected: element.isConnected }));
      new MutationObserver(() => window.focusTrace.push({ event: 'mutation', disabled: element.disabled, connected: element.isConnected })).observe(element, { attributes: true, attributeFilter: ['disabled'] });
    });
    if (method === 'click') await send.click();
    else if (method === 'keyboard') { await send.focus(); await page.keyboard.press('Enter'); }
    else await input.press('Enter');
    await expect.poll(() => requests.length).toBe(1);
  };
  const finish = async (parts = [{ type: 'start', messageId: 'reply-fixture' }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Synthetic response.' }, { type: 'text-end', id: 'text' }, { type: 'finish' }]) => {
    await requests.at(-1).fulfill({ headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' }, body: parts.map(part => 'data: ' + JSON.stringify(part) + '\n\n').join('') + 'data: [DONE]\n\n' });
  };
  const startStream = async () => {
    await requests.at(-1).continue({ url: origin + streamPath });
    await expect.poll(() => streams.has(streamPath)).toBe(true);
    await expect(page.getByText('Streaming response', { exact: true })).toBeVisible();
  };
  const finishStream = async () => {
    const response = streams.get(streamPath);
    assert.ok(response, 'Synthetic stream must still be open');
    writePart(response, { type: 'text-delta', id: 'text', delta: ' completed.' });
    writePart(response, { type: 'text-end', id: 'text' });
    writePart(response, { type: 'finish' });
    response.end('data: [DONE]\n\n');
    await expect(page.getByText('Streaming response completed.', { exact: true })).toBeVisible();
  };
  try {
    await run({ startStream, finishStream, page, input, send, other, requests, uploads, load, begin, finish, holdSearch: () => { holdSearch = true; }, releaseSearch: async () => { holdSearch = false; await Promise.all(searchRequests.slice(2).map(route => route.fulfill({ json: { mode: 'off', reason: 'Synthetic' } }).catch(() => {}))); } });
    assert.deepEqual(errors, []);
    console.log('PASS ' + name); passed++;
  } catch (error) {
    failures.push(name);
    console.error('FAIL ' + name + ': ' + error.message);
    console.error('TRACE ' + JSON.stringify(await page.evaluate(() => ({ focus: document.activeElement?.outerHTML.slice(0, 180), sameInput: window.originalInput === document.querySelector('textarea'), trace: window.focusTrace })).catch(() => ({}))));
  } finally { streams.get(streamPath)?.end(); await page.close(); }
}
try {
  for (const saved of [false, true]) for (const method of ['enter', 'click', 'keyboard']) {
    await check(`${saved ? 'saved' : 'first'} ${method}: focus during submitted/streaming and after finish`, async ({ page, input, load, begin, startStream, finishStream }) => {
      await load(saved ? '?saved' : ''); await begin(method);
      await expect(input).toBeFocused(); await expect(input).toBeEnabled();
      await startStream(); await expect(input).toBeFocused();
      await page.keyboard.type('Next draft'); await expect(input).toHaveValue('Next draft');
      await finishStream(); await expect(input).toBeFocused(); await expect(input).toHaveValue('Next draft');
    });
  }
  for (const action of ['other', 'blank', 'tab', 'window-blur']) {
    await check(`first send: delayed search verification respects ${action}`, async ({ page, input, other, load, begin, holdSearch, releaseSearch, finish }) => {
      await load(); holdSearch(); await begin(); await expect(input).toBeDisabled();
      if (action === 'other') await other.click();
      if (action === 'blank') await page.locator('#blank').click();
      if (action === 'tab') await page.keyboard.press('Tab');
      if (action === 'window-blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await releaseSearch(); await expect(input).toBeEnabled(); await expect(input).not.toBeFocused();
      await finish(); await expect(page.getByText('Synthetic response.', { exact: true })).toBeVisible(); await expect(input).not.toBeFocused();
      if (action === 'other') await expect(other).toBeFocused();
    });
  }
  await check('first send restores after delayed search verification', async ({ input, load, begin, holdSearch, releaseSearch, finish }) => {
    await load(); holdSearch(); await begin(); await expect(input).toBeDisabled();
    await releaseSearch(); await expect(input).toBeFocused(); await finish(); await expect(input).toBeFocused();
  });
  for (const move of [false, true]) await check(`HTTP unsaved rejection restores draft; moved=${move}`, async ({ input, other, requests, load, begin }) => {
    await load(); await begin('click'); if (move) await other.click();
    await requests[0].fulfill({ status: 400, json: { error: 'Synthetic refusal', unsavedMessageId: requests[0].request().postDataJSON().message.id } });
    await expect(input).toHaveValue('Synthetic message');
    if (move) await expect(other).toBeFocused(); else await expect(input).toBeFocused();
  });
  await check('stream failure does not steal another control; composer stays usable', async ({ page, input, other, load, begin, finish }) => {
    await load('?saved'); await begin('click'); await expect(input).toBeFocused(); await other.click();
    await finish([{ type: 'start', messageId: 'partial' }, { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'Partial response' }, { type: 'error', errorText: 'Synthetic stream failure' }]);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible(); await expect(other).toBeFocused();
    await input.fill('Retry draft'); await expect(input).toBeFocused();
  });
  for (const saved of [false, true]) await check(`${saved ? 'saved' : 'first'} attachment upload and file-only click send returns focus`, async ({ page, input, send, requests, uploads, load, finish }) => {
    await load(saved ? '?saved' : '');
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
    await expect.poll(() => uploads.length).toBe(1); await expect(send).toBeDisabled(); await input.focus(); await input.press('Enter'); assert.equal(requests.length, 0);
    await uploads[0].fulfill({ json: { id: 'file-fixture', url: '/api/files/file-fixture', filename: 'synthetic.txt', mediaType: 'text/plain' } });
    await expect(send).toBeEnabled(); await send.click(); await expect.poll(() => requests.length).toBe(1); await expect(input).toBeFocused();
    assert.equal(requests[0].request().postDataJSON().message.parts[0].filename, 'synthetic.txt');
    await expect(page.getByRole('button', { name: 'Remove synthetic.txt' })).toHaveCount(0); await finish();
  });
  await check('IME Enter and Shift+Enter preserve input; Enter sends multiline once', async ({ input, requests, load, finish }) => {
    await load('?saved'); await input.fill('First line'); await input.press('Shift+Enter'); await input.press('End'); await input.press('A');
    await expect(input).toHaveValue('First line\nA');
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    assert.equal(requests.length, 0); await expect(input).toBeFocused();
    await input.press('Enter'); await expect.poll(() => requests.length).toBe(1); assert.equal(requests[0].request().postDataJSON().message.parts[0].text, 'First line\nA');
    await expect(input).toBeFocused(); await finish();
  });
  for (const move of [false, true]) await check(`async rejected command retains draft and respects moved=${move}`, async ({ page, input, send, other, load }) => {
    await load('?command'); await input.fill('Synthetic command'); await send.click();
    await expect(input).toBeFocused(); if (move) await other.click();
    await page.evaluate(() => window.finishCommand()); await expect(send).toBeEnabled(); await expect(input).toHaveValue('Synthetic command');
    if (move) await expect(other).toBeFocused(); else await expect(input).toBeFocused();
  });
  for (const move of [false, true]) await check(`HTTP 500 preserves focus choice; moved=${move}`, async ({ page, input, other, requests, load, begin }) => {
    await load('?saved'); await begin('click'); await expect(input).toBeFocused(); if (move) await other.click();
    await requests[0].fulfill({ status: 500, json: { error: 'Synthetic server failure' } });
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    if (move) await expect(other).toBeFocused(); else await expect(input).toBeFocused();
  });
  await check('network failure leaves typing focus intact', async ({ page, input, requests, load, begin }) => {
    await load(); await begin('click'); await requests[0].abort('failed');
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible(); await expect(input).toBeFocused();
  });
  await check('stream completion respects an intentional move to another control', async ({ input, other, load, begin, startStream, finishStream }) => {
    await load(); await begin(); await startStream(); await expect(input).toBeFocused(); await other.click();
    await finishStream(); await expect(other).toBeFocused();
  });
  await check('sending a redirect during an open stream keeps typing focus', async ({ page, input, requests, load, begin, startStream, finish }) => {
    await load('?saved'); await begin(); await startStream(); await input.fill('Redirect instruction');
    await page.getByRole('button', { name: 'Stop and send', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2); await expect(input).toBeFocused();
    assert.equal(requests[1].request().postDataJSON().message.parts[0].text, 'Redirect instruction');
    await finish(); await expect(page.getByText('Synthetic response.', { exact: true })).toBeVisible(); await expect(input).toBeFocused();
  });
  await check('Stop remains keyboard accessible and does not restore typing focus', async ({ page, input, load, begin, startStream }) => {
    await load('?saved'); await begin(); await startStream();
    await page.getByRole('button', { name: 'Stop generating', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible(); await expect(input).not.toBeFocused();
  });
  await check('accepted async send keeps text typed while acceptance was pending', async ({ page, input, send, load }) => {
    await load('?command'); await input.fill('Original command'); await send.click(); await expect(input).toBeFocused();
    await page.keyboard.type('Next instruction'); await page.evaluate(() => window.finishCommand(true));
    await expect(input).toHaveValue('Original commandNext instruction'); await expect(input).toBeFocused(); await expect(send).toBeEnabled();
  });
  console.log(JSON.stringify({ passed, failed: failures.length, failures }));
  process.exitCode = failures.length ? 1 : 0;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
